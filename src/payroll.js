'use strict';
// Moteur de calcul des salaires horaires.
// Règles :
//  - Durées calculées uniquement à partir des pointages serveur (UTC), regroupés par jour local Africa/Bamako.
//  - Les intervalles qui se chevauchent sont fusionnés : aucune heure n'est comptée deux fois.
//  - Une arrivée sans départ ne compte pour aucune heure (signalée « incomplet », ou « en cours » le jour même).
//  - Le tarif appliqué à un jour est celui en vigueur à cette date (table taux_horaires).
//  - Les avances et retenues sont rattachées à un seul mois d'imputation : pas de double déduction.
//  - Un mois clôturé est servi depuis son instantané figé.

const t = require('./time');
const { getParam } = require('./db');

const DUREE_ANORMALE_MIN = 14 * 60;

function tauxPourDate(tauxListe, date) {
  // tauxListe triée par date_effet croissante
  let r = null;
  for (const x of tauxListe) if (x.date_effet <= date) r = x;
  return r || tauxListe[0];
}

function fusionner(intervalles) {
  const tri = [...intervalles].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of tri) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Calcul pur pour une secrétaire et un mois.
 * @param {object} p
 * @param {{id:number, nom:string, prenom:string, date_embauche?:string}} p.secretaire
 * @param {Array<{id:number, arrivee_utc:string, depart_utc:string|null, corrige?:number}>} p.pointages non annulés
 * @param {Array<{date_effet:string, taux:number, hs_seuil_minutes:number|null, hs_majoration_pct:number}>} p.tauxListe
 * @param {Array<{id:number, montant:number}>} p.avances  avances imputées sur ce mois, non annulées
 * @param {Array<{id:number, montant:number}>} p.retenues retenues imputées sur ce mois, non annulées
 * @param {number[]} p.joursOuvrables jours de semaine travaillés (0 = dimanche)
 * @param {string} p.mois « AAAA-MM »
 * @param {string} p.aujourdHui « AAAA-MM-JJ » (Bamako)
 */
function calculerSecretaire(p) {
  const { secretaire, mois, aujourdHui } = p;
  const tauxListe = [...p.tauxListe].sort((a, b) => a.date_effet.localeCompare(b.date_effet));

  const parJour = new Map();
  for (const pt of p.pointages) {
    const date = t.localDate(pt.arrivee_utc);
    if (!date.startsWith(mois)) continue;
    if (!parJour.has(date)) parJour.set(date, []);
    parJour.get(date).push(pt);
  }

  const jours = [];
  const incomplets = [];
  const anomalies = [];
  let minutesTotal = 0;
  let minutesHs = 0;
  let joursTravailles = 0;
  // Montants en 1/6000 de F CFA pour rester en arithmétique entière : minutes × taux × 100.
  let montantBase = 0;
  let montantHs = 0;
  const tauxUtilises = new Set();

  for (const date of [...parJour.keys()].sort()) {
    const pts = parJour.get(date).sort((a, b) => a.arrivee_utc.localeCompare(b.arrivee_utc));
    const intervalles = [];
    const presences = [];
    let enCours = false;
    let incomplet = false;
    for (const pt of pts) {
      const presence = {
        id: pt.id,
        arrivee: t.localTime(pt.arrivee_utc),
        depart: pt.depart_utc ? t.localTime(pt.depart_utc) : null,
        corrige: !!pt.corrige,
        statut: 'complet',
      };
      if (!pt.depart_utc) {
        if (date === aujourdHui) { presence.statut = 'en_cours'; enCours = true; }
        else {
          presence.statut = 'incomplet';
          incomplet = true;
          incomplets.push({ pointage_id: pt.id, date, arrivee: presence.arrivee });
        }
      } else {
        const s = Date.parse(pt.arrivee_utc);
        const e = Date.parse(pt.depart_utc);
        if (!(e > s)) {
          presence.statut = 'invalide';
          anomalies.push({ pointage_id: pt.id, date, message: 'Départ antérieur ou égal à l’arrivée' });
        } else {
          intervalles.push([s, e]);
          if (t.localDate(pt.depart_utc) !== date) presence.depart += ' (+1 j)';
        }
      }
      presences.push(presence);
    }

    const fusion = fusionner(intervalles);
    const ms = fusion.reduce((acc, [s, e]) => acc + (e - s), 0);
    const minutes = Math.floor(ms / 60000);
    if (minutes > DUREE_ANORMALE_MIN) {
      anomalies.push({ date, message: `Durée anormalement longue (${formatHeures(minutes)})` });
    }
    const tx = tauxPourDate(tauxListe, date);
    const hs = tx.hs_seuil_minutes != null && minutes > tx.hs_seuil_minutes ? minutes - tx.hs_seuil_minutes : 0;

    if (minutes > 0) {
      joursTravailles += 1;
      tauxUtilises.add(tx.taux);
    }
    minutesTotal += minutes;
    minutesHs += hs;
    montantBase += minutes * tx.taux * 100;
    montantHs += hs * tx.taux * (tx.hs_majoration_pct || 0);

    let statut = 'complet';
    if (incomplet) statut = 'incomplet';
    else if (enCours) statut = 'en_cours';
    jours.push({
      date,
      presences,
      minutes,
      minutes_hs: hs,
      taux: tx.taux,
      montant: Math.round((minutes * tx.taux * 100 + hs * tx.taux * (tx.hs_majoration_pct || 0)) / 6000),
      statut,
    });
  }

  // Absences : jours ouvrables écoulés, depuis l'embauche, sans aucun pointage.
  let absences = 0;
  const datesAbsence = [];
  for (const date of t.daysInMonth(mois)) {
    if (date >= aujourdHui) break;
    if (secretaire.date_embauche && date < secretaire.date_embauche) continue;
    if (!p.joursOuvrables.includes(t.weekday(date))) continue;
    if (!parJour.has(date)) { absences += 1; datesAbsence.push(date); }
  }

  const salaireBrut = Math.round((montantBase + montantHs) / 6000);
  const avancesTotal = p.avances.reduce((a, x) => a + x.montant, 0);
  const retenuesTotal = p.retenues.reduce((a, x) => a + x.montant, 0);
  const net = salaireBrut - avancesTotal - retenuesTotal;
  if (tauxUtilises.size === 0) tauxUtilises.add(tauxPourDate(tauxListe, `${mois}-01`).taux);

  return {
    id: secretaire.id,
    nom: secretaire.nom,
    prenom: secretaire.prenom,
    jours_travailles: joursTravailles,
    minutes: minutesTotal,
    minutes_hs: minutesHs,
    absences,
    dates_absence: datesAbsence,
    taux_appliques: [...tauxUtilises].sort((a, b) => a - b),
    salaire_brut: salaireBrut,
    avances_total: avancesTotal,
    retenues_total: retenuesTotal,
    net,
    solde_negatif: net < 0,
    incomplets,
    anomalies,
    jours,
    avances: p.avances,
    retenues: p.retenues,
  };
}

function formatHeures(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

function getCloture(db, mois) {
  return db.prepare(`SELECT c.*, u.nom_complet AS valide_par_nom FROM clotures c
    JOIN utilisateurs u ON u.id = c.valide_par WHERE c.mois = ?`).get(mois);
}

function moisCloture(db, mois) {
  return !!db.prepare('SELECT 1 FROM clotures WHERE mois = ?').get(mois);
}

function chargerPointagesMois(db, secretaireId, mois) {
  // Fenêtre élargie d'un jour de chaque côté, puis filtrage par date locale dans calculerSecretaire.
  const [y, m] = mois.split('-').map(Number);
  const debut = new Date(Date.UTC(y, m - 1, 1) - 86400000).toISOString();
  const fin = new Date(Date.UTC(y, m, 1) + 86400000).toISOString();
  return db.prepare(`SELECT id, arrivee_utc, depart_utc, corrige FROM pointages
    WHERE secretaire_id = ? AND annule = 0 AND arrivee_utc >= ? AND arrivee_utc < ?
    ORDER BY arrivee_utc`).all(secretaireId, debut, fin);
}

/**
 * Calcul (ou lecture de l'instantané) de la paie d'un mois pour toutes les secrétaires concernées.
 */
function calculerMois(db, mois, { now = new Date(), ignorerCloture = false } = {}) {
  if (!ignorerCloture) {
    const c = getCloture(db, mois);
    if (c) {
      const snap = JSON.parse(c.snapshot_json);
      snap.statut = 'cloture';
      snap.cloture = { valide_par: c.valide_par_nom, valide_le: c.valide_le, commentaire: c.commentaire };
      return snap;
    }
  }

  const aujourdHui = t.today(now);
  const tauxListe = db.prepare('SELECT date_effet, taux, hs_seuil_minutes, hs_majoration_pct FROM taux_horaires ORDER BY date_effet').all();
  const joursOuvrables = String(getParam(db, 'jours_ouvrables') || '').split(',').filter(Boolean).map(Number);
  const finMois = t.daysInMonth(mois).at(-1);

  // Secrétaires actives embauchées avant la fin du mois, plus toute secrétaire ayant des pointages/avances sur le mois.
  const secretaires = db.prepare('SELECT id, nom, prenom, date_embauche, actif FROM secretaires ORDER BY nom, prenom').all();
  const avStmt = db.prepare(`SELECT a.id, a.montant, a.date_operation, a.motif, u.nom_complet AS cree_par
    FROM avances a JOIN utilisateurs u ON u.id = a.cree_par
    WHERE a.secretaire_id = ? AND a.mois_imputation = ? AND a.annule = 0 ORDER BY a.date_operation, a.id`);
  const reStmt = db.prepare(`SELECT r.id, r.montant, r.date_operation, r.motif, u.nom_complet AS cree_par
    FROM retenues r JOIN utilisateurs u ON u.id = r.cree_par
    WHERE r.secretaire_id = ? AND r.mois_imputation = ? AND r.annule = 0 ORDER BY r.date_operation, r.id`);

  const lignes = [];
  for (const s of secretaires) {
    const pointages = chargerPointagesMois(db, s.id, mois);
    const avances = avStmt.all(s.id, mois);
    const retenues = reStmt.all(s.id, mois);
    const concernee = (s.actif && (!s.date_embauche || s.date_embauche <= finMois))
      || avances.length || retenues.length
      || pointages.some((p) => t.localDate(p.arrivee_utc).startsWith(mois));
    if (!concernee) continue;
    lignes.push(calculerSecretaire({
      secretaire: s, pointages, tauxListe, avances, retenues, joursOuvrables, mois, aujourdHui,
    }));
  }

  const totaux = lignes.reduce((acc, l) => {
    acc.minutes += l.minutes;
    acc.minutes_hs += l.minutes_hs;
    acc.jours_travailles += l.jours_travailles;
    acc.absences += l.absences;
    acc.salaire_brut += l.salaire_brut;
    acc.avances += l.avances_total;
    acc.retenues += l.retenues_total;
    acc.net += l.net;
    acc.incomplets += l.incomplets.length;
    return acc;
  }, { minutes: 0, minutes_hs: 0, jours_travailles: 0, absences: 0, salaire_brut: 0, avances: 0, retenues: 0, net: 0, incomplets: 0 });

  return {
    mois,
    libelle_mois: t.monthLabel(mois),
    entreprise: getParam(db, 'entreprise'),
    genere_le: now.toISOString(),
    statut: 'provisoire',
    mois_termine: finMois < aujourdHui,
    taux_en_vigueur: tauxListe.filter((x) => x.date_effet <= finMois).at(-1) || tauxListe[0],
    secretaires: lignes,
    totaux,
  };
}

module.exports = { calculerSecretaire, calculerMois, fusionner, formatHeures, moisCloture, getCloture, tauxPourDate };
