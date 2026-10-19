'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const { getParam, setParam, tx, journal } = require('./db');
const auth = require('./auth');
const t = require('./time');
const payroll = require('./payroll');
const reports = require('./reports');
const mailer = require('./mailer');

class HttpError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra; }
}
const fail = (code, msg, extra) => { throw new HttpError(code, msg, extra); };

const ANTI_DOUBLE_SCAN_MS = 60 * 1000;
const MONTANT_MAX = 10_000_000;

const nouveauBadge = () => crypto.randomBytes(18).toString('base64url');
const txt = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const estDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));

function montantValide(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MONTANT_MAX) fail(400, 'Montant invalide (nombre entier de F CFA, supérieur à 0).');
  return n;
}
function justificationValide(v) {
  const j = txt(v, 500);
  if (j.length < 5) fail(400, 'Une justification (au moins 5 caractères) est obligatoire.');
  return j;
}
function moisValide(m) {
  if (!t.isValidMonth(m)) fail(400, 'Mois invalide (format AAAA-MM).');
  return m;
}

// Adresses IPv4 du serveur sur le réseau local (pour que les téléphones le joignent via le Wi-Fi).
function adressesReseau() {
  return Object.values(require('node:os').networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function createApp(db,{ now = () => new Date() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Derrière le proxy https de l'hébergeur (Railway), faire confiance à un saut pour l'IP et le protocole.
  const trustProxy = process.env.TRUST_PROXY ?? (process.env.RAILWAY_ENVIRONMENT ? '1' : 'loopback');
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(auth.middleware(db));

  const admin = auth.requireRole('admin');
  const posteOuAdmin = auth.requireRole('admin', 'poste');
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { next(e); }
  };
  const verifierMoisOuvert = (mois, quoi = 'Cette opération') => {
    if (payroll.moisCloture(db, mois)) fail(409, `${quoi} concerne ${t.monthLabel(mois)}, qui est clôturé : modification impossible.`);
  };

  // ---------- Authentification ----------
  const adminExiste = () => !!db.prepare("SELECT 1 FROM utilisateurs WHERE role = 'admin'").get();

  app.get('/api/etat', (req, res) => {
    res.json({ installe: adminExiste(), utilisateur: req.user || null, entreprise: getParam(db, 'entreprise') });
  });

  app.post('/api/installation', wrap((req, res) => {
    if (adminExiste()) fail(409, 'L’application est déjà installée.');
    const { nom_complet, nom_utilisateur, mot_de_passe } = req.body || {};
    const err = auth.validerMotDePasse(mot_de_passe);
    if (err) fail(400, err);
    if (!txt(nom_complet) || !/^[a-zA-Z0-9._-]{3,40}$/.test(nom_utilisateur || '')) fail(400, 'Nom ou identifiant invalide (3 à 40 caractères : lettres, chiffres, . _ -).');
    db.prepare("INSERT INTO utilisateurs (nom_utilisateur, nom_complet, mot_de_passe_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(nom_utilisateur, txt(nom_complet, 80), auth.hashPassword(mot_de_passe));
    const r = auth.login(db, req, res, nom_utilisateur, mot_de_passe);
    journal(db, r.utilisateur.id, 'installation', null);
    res.json(r);
  }));

  app.post('/api/connexion', wrap((req, res) => {
    const r = auth.login(db, req, res, req.body?.nom_utilisateur, req.body?.mot_de_passe);
    if (r.erreur) return res.status(r.code).json({ erreur: r.erreur });
    journal(db, r.utilisateur.id, 'connexion', { ip: req.ip });
    res.json(r);
  }));

  app.post('/api/deconnexion', (req, res) => {
    auth.logout(db, req, res);
    res.json({ ok: true });
  });

  app.post('/api/mot-de-passe', posteOuAdmin, wrap((req, res) => {
    const u = db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(req.user.id);
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(String(req.body?.actuel || ''), u.mot_de_passe_hash)) fail(400, 'Mot de passe actuel incorrect.');
    const err = auth.validerMotDePasse(req.body?.nouveau);
    if (err) fail(400, err);
    db.prepare('UPDATE utilisateurs SET mot_de_passe_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.nouveau), u.id);
    journal(db, u.id, 'changement_mot_de_passe', null);
    res.json({ ok: true });
  }));

  // ---------- Pointage QR ----------
  // Enregistre un passage : arrivée s'il n'y a pas de présence ouverte aujourd'hui, sinon départ.
  function enregistrerPassage(sec, { source = 'qr', appareilId = null, distance = null } = {}) {
    if (!sec.actif) fail(403, `${sec.prenom} ${sec.nom} n’est plus active : pointage refusé.`);
    const instant = now();
    const iso = instant.toISOString();
    const aujourdHui = t.today(instant);

    const resultat = tx(db, () => {
      const dernier = db.prepare(`SELECT *, COALESCE(depart_utc, arrivee_utc) AS derniere FROM pointages
        WHERE secretaire_id = ? AND annule = 0 ORDER BY COALESCE(depart_utc, arrivee_utc) DESC LIMIT 1`).get(sec.id);
      if (dernier && instant - Date.parse(dernier.derniere) < ANTI_DOUBLE_SCAN_MS && instant >= Date.parse(dernier.derniere)) {
        fail(409, `Pointage déjà enregistré pour ${sec.prenom} ${sec.nom} il y a moins d’une minute.`);
      }
      const ouvert = db.prepare(`SELECT * FROM pointages WHERE secretaire_id = ? AND annule = 0 AND depart_utc IS NULL
        ORDER BY arrivee_utc DESC LIMIT 1`).get(sec.id);
      if (ouvert && t.localDate(ouvert.arrivee_utc) === aujourdHui) {
        db.prepare('UPDATE pointages SET depart_utc = ?, distance_depart_m = ? WHERE id = ?').run(iso, distance, ouvert.id);
        return { type: 'depart', pointage_id: ouvert.id, minutes: Math.floor((instant - Date.parse(ouvert.arrivee_utc)) / 60000), arrivee: t.localTime(ouvert.arrivee_utc) };
      }
      const r = db.prepare('INSERT INTO pointages (secretaire_id, arrivee_utc, source, appareil_id, distance_arrivee_m) VALUES (?, ?, ?, ?, ?)')
        .run(sec.id, iso, source, appareilId, distance);
      return { type: 'arrivee', pointage_id: Number(r.lastInsertRowid), incomplet_precedent: ouvert ? t.localDate(ouvert.arrivee_utc) : null };
    });
    const passage = { ...resultat, secretaire: `${sec.prenom} ${sec.nom}`, heure: t.localTime(iso), date: aujourdHui };
    // Envoi en arrière-plan : un SMTP lent ou en panne ne retarde ni ne fait échouer le pointage.
    setImmediate(() => mailer.notifierPassage(db, { ...passage, source }));
    return passage;
  }

  // Badge QR personnel scanné sur le poste de la boutique (mode de secours).
  app.post('/api/pointage/scan', posteOuAdmin, wrap((req, res) => {
    let code = txt(req.body?.code, 200);
    if (code.toUpperCase().startsWith('DCS:')) code = code.slice(4);
    if (!code) fail(400, 'QR code vide.');
    const sec = db.prepare('SELECT * FROM secretaires WHERE badge_token = ?').get(code);
    const consigner = (resultat, motif, r = {}) => db.prepare(`INSERT INTO tentatives_pointage
      (cree_le, secretaire_id, source, resultat, type, motif, pointage_id, ip) VALUES (?, ?, 'qr', ?, ?, ?, ?, ?)`)
      .run(now().toISOString(), sec?.id ?? null, resultat, r.type ?? null, motif, r.pointage_id ?? null, req.ip ?? null);
    try {
      if (!sec) fail(404, 'Badge inconnu. Vérifiez le QR code.');
      const r = enregistrerPassage(sec, { source: 'qr' });
      consigner('accepte', 'Badge vérifié sur le poste de la boutique', r);
      journal(db, req.user.id, `scan_${r.type}`, { secretaire_id: sec.id, pointage_id: r.pointage_id });
      res.json(r);
    } catch (e) {
      consigner('refuse', e.message);
      throw e;
    }
  }));

  // Pointage depuis le téléphone personnel des secrétaires.
  require('./telephone').register(app, db, { now, fail, wrap, txt, admin, posteOuAdmin, enregistrerPassage });

  app.get('/api/pointage/aujourdhui', posteOuAdmin, (req, res) => {
    const aujourdHui = t.today(now());
    const secs = db.prepare('SELECT id, nom, prenom FROM secretaires WHERE actif = 1 ORDER BY nom, prenom').all();
    const pts = db.prepare(`SELECT * FROM pointages WHERE annule = 0 AND arrivee_utc >= ? AND arrivee_utc <= ? ORDER BY arrivee_utc`)
      .all(new Date(Date.parse(aujourdHui) - 86400000).toISOString(), new Date(Date.parse(aujourdHui) + 2 * 86400000).toISOString())
      .filter((p) => t.localDate(p.arrivee_utc) === aujourdHui);
    res.json({
      date: aujourdHui,
      liste: secs.map((s) => {
        const mes = pts.filter((p) => p.secretaire_id === s.id);
        const ouvert = mes.find((p) => !p.depart_utc);
        return {
          id: s.id, nom: s.nom, prenom: s.prenom,
          statut: ouvert ? 'present' : mes.length ? 'parti' : 'absent',
          presences: mes.map((p) => ({ arrivee: t.localTime(p.arrivee_utc), depart: p.depart_utc ? t.localTime(p.depart_utc) : null })),
        };
      }),
    });
  });

  // ---------- Secrétaires ----------
  app.get('/api/secretaires', admin, (req, res) => {
    res.json(db.prepare(`SELECT s.id, s.nom, s.prenom, s.telephone, s.date_embauche, s.actif, s.cree_le, s.archive, s.archive_le,
      u.nom_complet AS archive_par_nom FROM secretaires s LEFT JOIN utilisateurs u ON u.id = s.archive_par
      ORDER BY s.archive, s.actif DESC, s.nom, s.prenom`).all());
  });

  // Données attachées à une secrétaire : décide entre suppression définitive et archivage.
  function donneesLiees(id) {
    const n = (sql) => db.prepare(sql).get(id).n;
    const dansInstantanes = (table) => db.prepare(`SELECT mois, snapshot_json FROM ${table}`).all()
      .filter((c) => JSON.parse(c.snapshot_json).secretaires.some((s) => s.id === id)).map((c) => c.mois);
    const liens = {
      pointages: n('SELECT COUNT(*) AS n FROM pointages WHERE secretaire_id = ?'),
      avances: n('SELECT COUNT(*) AS n FROM avances WHERE secretaire_id = ?'),
      retenues: n('SELECT COUNT(*) AS n FROM retenues WHERE secretaire_id = ?'),
      mois_clotures: [...new Set([...dansInstantanes('clotures'), ...dansInstantanes('clotures_archives')])].sort(),
    };
    liens.definitive_possible = !liens.pointages && !liens.avances && !liens.retenues && !liens.mois_clotures.length;
    return liens;
  }
  const secretaireOuEchec = (id) => {
    const s = db.prepare('SELECT * FROM secretaires WHERE id = ?').get(Number(id));
    if (!s) fail(404, 'Secrétaire introuvable.');
    return s;
  };

  app.get('/api/secretaires/:id/suppression', admin, wrap((req, res) => {
    const s = secretaireOuEchec(req.params.id);
    res.json({ id: s.id, nom: `${s.prenom} ${s.nom}`, archive: !!s.archive, ...donneesLiees(s.id) });
  }));

  // Supprimer : définitif seulement sans aucune donnée liée ; sinon archivage qui conserve tout l'historique.
  app.delete('/api/secretaires/:id', admin, wrap((req, res) => {
    const s = secretaireOuEchec(req.params.id);
    if (req.body?.confirmation !== 'SUPPRIMER') fail(400, 'Confirmation manquante : saisissez SUPPRIMER pour confirmer.');
    const liens = donneesLiees(s.id);
    const nom = `${s.prenom} ${s.nom}`;
    if (liens.definitive_possible) {
      tx(db, () => {
        db.prepare('DELETE FROM appareils WHERE secretaire_id = ?').run(s.id);
        db.prepare('DELETE FROM codes_activation WHERE secretaire_id = ?').run(s.id);
        // Les tentatives (journal de sécurité) sont conservées, détachées de la fiche supprimée.
        db.prepare('UPDATE tentatives_pointage SET secretaire_id = NULL, motif = COALESCE(motif, \'\') || ? WHERE secretaire_id = ?')
          .run(` [secrétaire supprimée : ${nom}]`, s.id);
        db.prepare('DELETE FROM secretaires WHERE id = ?').run(s.id);
      });
      journal(db, req.user.id, 'secretaire_suppression_definitive', { id: s.id, nom });
      return res.json({ mode: 'definitive', nom });
    }
    if (s.archive) fail(409, `${nom} est déjà archivée.`);
    tx(db, () => {
      db.prepare('UPDATE secretaires SET archive = 1, actif = 0, archive_le = ?, archive_par = ?, badge_token = ? WHERE id = ?')
        .run(now().toISOString(), req.user.id, nouveauBadge(), s.id);
      db.prepare('UPDATE appareils SET revoque = 1 WHERE secretaire_id = ? AND revoque = 0').run(s.id);
      db.prepare('UPDATE codes_activation SET utilise = 1 WHERE secretaire_id = ? AND utilise = 0').run(s.id);
    });
    journal(db, req.user.id, 'secretaire_archivage', { id: s.id, nom, liens });
    res.json({ mode: 'archivee', nom, liens });
  }));

  app.post('/api/secretaires/:id/restaurer', admin, wrap((req, res) => {
    const s = secretaireOuEchec(req.params.id);
    if (!s.archive) fail(409, 'Cette secrétaire n’est pas archivée.');
    db.prepare('UPDATE secretaires SET archive = 0, archive_le = NULL, archive_par = NULL WHERE id = ?').run(s.id);
    journal(db, req.user.id, 'secretaire_restauration', { id: s.id });
    res.json({ ok: true });
  }));

  const lireSecretaire = (b) => {
    const s = { nom: txt(b.nom, 60), prenom: txt(b.prenom, 60), telephone: txt(b.telephone, 30) || null, date_embauche: b.date_embauche || null };
    if (!s.nom || !s.prenom) fail(400, 'Nom et prénom obligatoires.');
    if (s.date_embauche && !estDate(s.date_embauche)) fail(400, 'Date d’embauche invalide.');
    return s;
  };

  app.post('/api/secretaires', admin, wrap((req, res) => {
    const s = lireSecretaire(req.body || {});
    const r = db.prepare('INSERT INTO secretaires (nom, prenom, telephone, date_embauche, badge_token) VALUES (?, ?, ?, ?, ?)')
      .run(s.nom, s.prenom, s.telephone, s.date_embauche, nouveauBadge());
    journal(db, req.user.id, 'secretaire_creation', { id: Number(r.lastInsertRowid), ...s });
    res.json({ id: Number(r.lastInsertRowid) });
  }));

  app.put('/api/secretaires/:id', admin, wrap((req, res) => {
    const s = lireSecretaire(req.body || {});
    const actif = req.body?.actif === false || req.body?.actif === 0 ? 0 : 1;
    const existante = db.prepare('SELECT archive FROM secretaires WHERE id = ?').get(Number(req.params.id));
    if (existante?.archive && actif) fail(409, 'Cette secrétaire est archivée : restaurez-la d’abord.');
    const r = db.prepare('UPDATE secretaires SET nom = ?, prenom = ?, telephone = ?, date_embauche = ?, actif = ? WHERE id = ?')
      .run(s.nom, s.prenom, s.telephone, s.date_embauche, actif, Number(req.params.id));
    if (!r.changes) fail(404, 'Secrétaire introuvable.');
    journal(db, req.user.id, 'secretaire_modification', { id: Number(req.params.id), ...s, actif });
    res.json({ ok: true });
  }));

  app.post('/api/secretaires/:id/nouveau-badge', admin, wrap((req, res) => {
    const r = db.prepare('UPDATE secretaires SET badge_token = ? WHERE id = ?').run(nouveauBadge(), Number(req.params.id));
    if (!r.changes) fail(404, 'Secrétaire introuvable.');
    journal(db, req.user.id, 'badge_regenere', { id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  app.get('/api/secretaires/:id/qr.png', admin, wrap(async (req, res) => {
    const s = db.prepare('SELECT badge_token FROM secretaires WHERE id = ?').get(Number(req.params.id));
    if (!s) fail(404, 'Secrétaire introuvable.');
    const png = await QRCode.toBuffer(`DCS:${s.badge_token}`, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'no-store');
    res.type('png').send(png);
  }));

  // ---------- Pointages et corrections ----------
  app.get('/api/pointages', admin, wrap((req, res) => {
    const mois = moisValide(req.query.mois);
    const [y, m] = mois.split('-').map(Number);
    const debut = new Date(Date.UTC(y, m - 1, 1) - 86400000).toISOString();
    const fin = new Date(Date.UTC(y, m, 1) + 86400000).toISOString();
    const params = [debut, fin];
    let filtre = '';
    if (req.query.secretaire_id) { filtre = ' AND p.secretaire_id = ?'; params.push(Number(req.query.secretaire_id)); }
    const aujourdHui = t.today(now());
    const rows = db.prepare(`SELECT p.*, s.nom, s.prenom FROM pointages p JOIN secretaires s ON s.id = p.secretaire_id
      WHERE p.arrivee_utc >= ? AND p.arrivee_utc < ?${filtre} ORDER BY p.arrivee_utc DESC`).all(...params)
      .filter((p) => t.localDate(p.arrivee_utc).startsWith(mois))
      .map((p) => {
        const date = t.localDate(p.arrivee_utc);
        let statut = 'complet';
        if (p.annule) statut = 'annule';
        else if (!p.depart_utc) statut = date === aujourdHui ? 'en_cours' : 'incomplet';
        return {
          id: p.id, secretaire_id: p.secretaire_id, secretaire: `${p.prenom} ${p.nom}`, date,
          arrivee: t.localTime(p.arrivee_utc), depart: p.depart_utc ? t.localTime(p.depart_utc) : null,
          depart_date: p.depart_utc ? t.localDate(p.depart_utc) : null,
          minutes: p.depart_utc ? Math.max(0, Math.floor((Date.parse(p.depart_utc) - Date.parse(p.arrivee_utc)) / 60000)) : null,
          source: p.source, corrige: !!p.corrige, statut,
          distance_arrivee_m: p.distance_arrivee_m, distance_depart_m: p.distance_depart_m,
        };
      });
    res.json({ mois, cloture: payroll.moisCloture(db, mois), pointages: rows });
  }));

  const lirePointage = (b) => {
    const date = b.date;
    if (!estDate(date)) fail(400, 'Date invalide.');
    let arrivee, depart = null;
    try {
      arrivee = t.localToUtcIso(date, b.arrivee);
      if (b.depart) depart = t.localToUtcIso(b.depart_date && estDate(b.depart_date) ? b.depart_date : date, b.depart);
    } catch { fail(400, 'Heure invalide (format HH:MM).'); }
    if (depart && Date.parse(depart) <= Date.parse(arrivee)) fail(400, 'L’heure de départ doit être postérieure à l’heure d’arrivée.');
    if (Date.parse(arrivee) > now().getTime() || (depart && Date.parse(depart) > now().getTime())) fail(400, 'Impossible d’enregistrer un pointage dans le futur.');
    return { date, arrivee, depart };
  };
  const valeurPointage = (p) => p && ({
    date: t.localDate(p.arrivee_utc), arrivee: t.localTime(p.arrivee_utc),
    depart: p.depart_utc ? t.localDateTime(p.depart_utc) : null, annule: !!p.annule,
  });

  app.post('/api/pointages', admin, wrap((req, res) => {
    const secId = Number(req.body?.secretaire_id);
    const sp = db.prepare('SELECT archive FROM secretaires WHERE id = ?').get(secId);
    if (!sp) fail(400, 'Secrétaire introuvable.');
    if (sp.archive) fail(409, 'Cette secrétaire est archivée : restaurez-la d’abord.');
    const p = lirePointage(req.body || {});
    const justification = justificationValide(req.body?.justification);
    verifierMoisOuvert(p.date.slice(0, 7), 'Ce pointage');
    const id = tx(db, () => {
      const r = db.prepare("INSERT INTO pointages (secretaire_id, arrivee_utc, depart_utc, source, corrige) VALUES (?, ?, ?, 'correction', 1)")
        .run(secId, p.arrivee, p.depart);
      const id = Number(r.lastInsertRowid);
      db.prepare("INSERT INTO corrections_pointage (pointage_id, action, ancienne_valeur, nouvelle_valeur, justification, admin_id) VALUES (?, 'creation', NULL, ?, ?, ?)")
        .run(id, JSON.stringify(valeurPointage(db.prepare('SELECT * FROM pointages WHERE id = ?').get(id))), justification, req.user.id);
      return id;
    });
    res.json({ id });
  }));

  app.put('/api/pointages/:id', admin, wrap((req, res) => {
    const ancien = db.prepare('SELECT * FROM pointages WHERE id = ?').get(Number(req.params.id));
    if (!ancien) fail(404, 'Pointage introuvable.');
    if (ancien.annule) fail(409, 'Ce pointage est annulé.');
    const p = lirePointage(req.body || {});
    const justification = justificationValide(req.body?.justification);
    verifierMoisOuvert(t.localDate(ancien.arrivee_utc).slice(0, 7), 'Ce pointage');
    verifierMoisOuvert(p.date.slice(0, 7), 'Ce pointage');
    tx(db, () => {
      db.prepare('UPDATE pointages SET arrivee_utc = ?, depart_utc = ?, corrige = 1 WHERE id = ?').run(p.arrivee, p.depart, ancien.id);
      db.prepare("INSERT INTO corrections_pointage (pointage_id, action, ancienne_valeur, nouvelle_valeur, justification, admin_id) VALUES (?, 'modification', ?, ?, ?, ?)")
        .run(ancien.id, JSON.stringify(valeurPointage(ancien)),
          JSON.stringify(valeurPointage(db.prepare('SELECT * FROM pointages WHERE id = ?').get(ancien.id))), justification, req.user.id);
    });
    res.json({ ok: true });
  }));

  app.post('/api/pointages/:id/annuler', admin, wrap((req, res) => {
    const ancien = db.prepare('SELECT * FROM pointages WHERE id = ?').get(Number(req.params.id));
    if (!ancien) fail(404, 'Pointage introuvable.');
    if (ancien.annule) fail(409, 'Ce pointage est déjà annulé.');
    const justification = justificationValide(req.body?.justification);
    verifierMoisOuvert(t.localDate(ancien.arrivee_utc).slice(0, 7), 'Ce pointage');
    tx(db, () => {
      db.prepare('UPDATE pointages SET annule = 1, corrige = 1 WHERE id = ?').run(ancien.id);
      db.prepare("INSERT INTO corrections_pointage (pointage_id, action, ancienne_valeur, nouvelle_valeur, justification, admin_id) VALUES (?, 'annulation', ?, NULL, ?, ?)")
        .run(ancien.id, JSON.stringify(valeurPointage(ancien)), justification, req.user.id);
    });
    res.json({ ok: true });
  }));

  app.get('/api/corrections', admin, wrap((req, res) => {
    const params = [];
    let filtre = '';
    if (req.query.pointage_id) { filtre = 'WHERE c.pointage_id = ?'; params.push(Number(req.query.pointage_id)); }
    const rows = db.prepare(`SELECT c.*, u.nom_complet AS admin, s.prenom || ' ' || s.nom AS secretaire
      FROM corrections_pointage c JOIN utilisateurs u ON u.id = c.admin_id
      JOIN pointages p ON p.id = c.pointage_id JOIN secretaires s ON s.id = p.secretaire_id
      ${filtre} ORDER BY c.cree_le DESC LIMIT 500`).all(...params)
      .map((c) => ({ ...c, ancienne_valeur: JSON.parse(c.ancienne_valeur || 'null'), nouvelle_valeur: JSON.parse(c.nouvelle_valeur || 'null'), cree_le_local: t.localDateTime(c.cree_le) }));
    res.json(rows);
  }));

  // ---------- Avances et retenues ----------
  for (const [table, libelle, motifObligatoire] of [['avances', 'Avance', false], ['retenues', 'Retenue', true]]) {
    app.get(`/api/${table}`, admin, wrap((req, res) => {
      const mois = moisValide(req.query.mois);
      res.json(db.prepare(`SELECT x.*, s.prenom || ' ' || s.nom AS secretaire, u.nom_complet AS cree_par_nom, ua.nom_complet AS annule_par_nom
        FROM ${table} x JOIN secretaires s ON s.id = x.secretaire_id JOIN utilisateurs u ON u.id = x.cree_par
        LEFT JOIN utilisateurs ua ON ua.id = x.annule_par
        WHERE x.mois_imputation = ? ORDER BY x.date_operation DESC, x.id DESC`).all(mois));
    }));

    app.post(`/api/${table}`, admin, wrap((req, res) => {
      const b = req.body || {};
      const secId = Number(b.secretaire_id);
      const so = db.prepare('SELECT archive FROM secretaires WHERE id = ?').get(secId);
      if (!so) fail(400, 'Secrétaire introuvable.');
      if (so.archive) fail(409, 'Cette secrétaire est archivée : restaurez-la d’abord.');
      const montant = montantValide(b.montant);
      if (!estDate(b.date_operation)) fail(400, 'Date invalide.');
      const mois = b.mois_imputation ? moisValide(b.mois_imputation) : b.date_operation.slice(0, 7);
      const motif = txt(b.motif, 300);
      if (motifObligatoire && motif.length < 3) fail(400, 'Le motif de la retenue est obligatoire.');
      verifierMoisOuvert(mois, `Cette ${libelle.toLowerCase()}`);
      const r = db.prepare(`INSERT INTO ${table} (secretaire_id, montant, date_operation, mois_imputation, motif, cree_par) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(secId, montant, b.date_operation, mois, motif || null, req.user.id);
      journal(db, req.user.id, `${table}_creation`, { id: Number(r.lastInsertRowid), secretaire_id: secId, montant, mois });
      res.json({ id: Number(r.lastInsertRowid) });
    }));

    app.post(`/api/${table}/:id/annuler`, admin, wrap((req, res) => {
      const x = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params.id));
      if (!x) fail(404, `${libelle} introuvable.`);
      if (x.annule) fail(409, `${libelle} déjà annulée.`);
      const justification = justificationValide(req.body?.justification);
      verifierMoisOuvert(x.mois_imputation, `Cette ${libelle.toLowerCase()}`);
      db.prepare(`UPDATE ${table} SET annule = 1, annule_par = ?, annule_le = ?, motif_annulation = ? WHERE id = ?`)
        .run(req.user.id, new Date().toISOString(), justification, x.id);
      journal(db, req.user.id, `${table}_annulation`, { id: x.id, justification });
      res.json({ ok: true });
    }));
  }

  // ---------- Paie ----------
  app.get('/api/paie', admin, wrap((req, res) => {
    const mois = moisValide(req.query.mois);
    res.json(payroll.calculerMois(db, mois, { now: now() }));
  }));

  const nomFichier = (mois, ext) => `DCS_Salaires_${mois}.${ext}`;
  app.get('/api/paie/:mois/rapport.pdf', admin, wrap(async (req, res) => {
    const mois = moisValide(req.params.mois);
    const pdf = await reports.genererPdf(payroll.calculerMois(db, mois, { now: now() }));
    res.type('pdf').setHeader('Content-Disposition', `${req.query.telecharger ? 'attachment' : 'inline'}; filename="${nomFichier(mois, 'pdf')}"`);
    res.send(pdf);
  }));
  app.get('/api/paie/:mois/rapport.xlsx', admin, wrap(async (req, res) => {
    const mois = moisValide(req.params.mois);
    const xlsx = await reports.genererExcel(payroll.calculerMois(db, mois, { now: now() }));
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', `attachment; filename="${nomFichier(mois, 'xlsx')}"`);
    res.send(xlsx);
  }));

  async function envoyerRecap(mois) {
    const rapport = payroll.calculerMois(db, mois, { now: now() });
    let pdf = null;
    try { pdf = await reports.genererPdf(rapport); } catch { /* l'e-mail part sans pièce jointe */ }
    return mailer.envoyerRecapMensuel(db, rapport, pdf);
  }

  app.post('/api/paie/:mois/cloturer', admin, wrap(async (req, res) => {
    const mois = moisValide(req.params.mois);
    if (mois >= t.currentMonth(now())) fail(400, 'Seul un mois terminé peut être clôturé.');
    if (payroll.moisCloture(db, mois)) fail(409, 'Ce mois est déjà clôturé.');
    const calcul = payroll.calculerMois(db, mois, { now: now(), ignorerCloture: true });
    if (calcul.totaux.incomplets > 0 && req.body?.confirmer_incomplets !== true) {
      fail(409, `${calcul.totaux.incomplets} pointage(s) incomplet(s) restent à corriger. Corrigez-les ou confirmez la clôture en connaissance de cause (ils ne seront pas comptés).`);
    }
    const commentaire = txt(req.body?.commentaire, 500) || null;
    db.prepare('INSERT INTO clotures (mois, snapshot_json, valide_par, commentaire) VALUES (?, ?, ?, ?)')
      .run(mois, JSON.stringify({ ...calcul, statut: 'cloture' }), req.user.id, commentaire);
    journal(db, req.user.id, 'cloture_paie', { mois, totaux: calcul.totaux });
    const email = await envoyerRecap(mois);
    res.json({ ok: true, email });
  }));

  app.post('/api/paie/:mois/renvoyer-email', admin, wrap(async (req, res) => {
    const mois = moisValide(req.params.mois);
    if (!payroll.moisCloture(db, mois)) fail(409, 'Le récapitulatif n’est envoyé qu’après validation de la paie.');
    res.json(await envoyerRecap(mois));
  }));

  app.get('/api/clotures', admin, (req, res) => {
    res.json(db.prepare(`SELECT c.mois, c.valide_le, c.commentaire, u.nom_complet AS valide_par, c.snapshot_json FROM clotures c
      JOIN utilisateurs u ON u.id = c.valide_par ORDER BY c.mois DESC`).all()
      .map(({ snapshot_json, ...c }) => ({ ...c, libelle: t.monthLabel(c.mois), totaux: JSON.parse(snapshot_json).totaux })));
  });

  // Correction exceptionnelle : le mois clôturé est rouvert, sa version validée est archivée intacte.
  app.post('/api/paie/:mois/rouvrir', admin, wrap((req, res) => {
    const mois = moisValide(req.params.mois);
    const justification = justificationValide(req.body?.justification);
    tx(db, () => {
      const c = db.prepare('SELECT * FROM clotures WHERE mois = ?').get(mois);
      if (!c) fail(409, 'Ce mois n’est pas clôturé.');
      db.prepare(`INSERT INTO clotures_archives (mois, snapshot_json, valide_par, valide_le, commentaire, rouvert_par, justification)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(mois, c.snapshot_json, c.valide_par, c.valide_le, c.commentaire, req.user.id, justification);
      db.prepare('DELETE FROM clotures WHERE mois = ?').run(mois);
    });
    journal(db, req.user.id, 'reouverture_paie', { mois, justification });
    res.json({ ok: true });
  }));

  app.get('/api/clotures/archives', admin, (req, res) => {
    res.json(db.prepare(`SELECT a.id, a.mois, a.valide_le, a.rouvert_le, a.justification, a.snapshot_json,
      uv.nom_complet AS valide_par, ur.nom_complet AS rouvert_par FROM clotures_archives a
      JOIN utilisateurs uv ON uv.id = a.valide_par JOIN utilisateurs ur ON ur.id = a.rouvert_par ORDER BY a.id DESC`).all()
      .map(({ snapshot_json, ...a }) => ({ ...a, libelle: t.monthLabel(a.mois), totaux: JSON.parse(snapshot_json).totaux })));
  });

  const rapportArchive = (id) => {
    const a = db.prepare(`SELECT a.*, uv.nom_complet AS valide_par_nom, ur.nom_complet AS rouvert_par_nom FROM clotures_archives a
      JOIN utilisateurs uv ON uv.id = a.valide_par JOIN utilisateurs ur ON ur.id = a.rouvert_par WHERE a.id = ?`).get(Number(id));
    if (!a) fail(404, 'Version archivée introuvable.');
    return {
      ...JSON.parse(a.snapshot_json),
      statut: 'archive',
      cloture: { valide_par: a.valide_par_nom, valide_le: a.valide_le, commentaire: a.commentaire },
      archive: { rouvert_par: a.rouvert_par_nom, rouvert_le: a.rouvert_le, justification: a.justification },
    };
  };
  app.get('/api/clotures/archives/:id/rapport.pdf', admin, wrap(async (req, res) => {
    const r = rapportArchive(req.params.id);
    res.type('pdf').setHeader('Content-Disposition', `inline; filename="DCS_Salaires_${r.mois}_version_archivee_${Number(req.params.id)}.pdf"`);
    res.send(await reports.genererPdf(r));
  }));
  app.get('/api/clotures/archives/:id/rapport.xlsx', admin, wrap(async (req, res) => {
    const r = rapportArchive(req.params.id);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', `attachment; filename="DCS_Salaires_${r.mois}_version_archivee_${Number(req.params.id)}.xlsx"`);
    res.send(await reports.genererExcel(r));
  }));

  app.get('/api/emails', admin, (req, res) => {
    // Les notifications de pointage (mois NULL) ne doivent pas faire disparaître les récapitulatifs mensuels.
    const recaps = db.prepare('SELECT * FROM emails WHERE mois IS NOT NULL ORDER BY id DESC LIMIT 100').all();
    const notifs = db.prepare('SELECT * FROM emails WHERE mois IS NULL ORDER BY id DESC LIMIT 100').all();
    res.json([...recaps, ...notifs].sort((a, b) => b.id - a.id));
  });

  app.get('/api/tableau-de-bord', admin, (req, res) => {
    const instant = now();
    const courant = t.currentMonth(instant);
    // Mois terminés (12 derniers) ayant de l'activité et non clôturés : paie à valider.
    const aValider = [];
    let m = courant;
    for (let i = 0; i < 12; i++) {
      m = t.previousMonth(m);
      if (payroll.moisCloture(db, m)) continue;
      const [y, mm] = m.split('-').map(Number);
      const actif = db.prepare('SELECT 1 FROM pointages WHERE annule = 0 AND arrivee_utc >= ? AND arrivee_utc < ? LIMIT 1')
        .get(new Date(Date.UTC(y, mm - 1, 1)).toISOString(), new Date(Date.UTC(y, mm, 1)).toISOString());
      if (actif) {
        const c = payroll.calculerMois(db, m, { now: instant });
        aValider.push({ mois: m, libelle: c.libelle_mois, totaux: c.totaux });
      }
    }
    const courantCalc = payroll.calculerMois(db, courant, { now: instant });
    res.json({
      mois_courant: { mois: courant, libelle: courantCalc.libelle_mois, totaux: courantCalc.totaux },
      a_valider: aValider,
      smtp: mailer.smtpConfigure(),
      email_admin: getParam(db, 'email_admin'),
    });
  });

  // ---------- Paramètres ----------
  app.get('/api/taux', admin, (req, res) => {
    res.json(db.prepare(`SELECT t.*, u.nom_complet AS cree_par_nom FROM taux_horaires t
      LEFT JOIN utilisateurs u ON u.id = t.cree_par ORDER BY date_effet DESC`).all());
  });

  app.post('/api/taux', admin, wrap((req, res) => {
    const b = req.body || {};
    if (!estDate(b.date_effet)) fail(400, 'Date d’effet invalide.');
    const taux = Number(b.taux);
    if (!Number.isInteger(taux) || taux <= 0 || taux > 100000) fail(400, 'Tarif horaire invalide.');
    let seuil = null;
    if (b.hs_seuil_heures !== '' && b.hs_seuil_heures != null) {
      const h = Number(b.hs_seuil_heures);
      if (!(h > 0 && h <= 24)) fail(400, 'Seuil d’heures supplémentaires invalide.');
      seuil = Math.round(h * 60);
    }
    const maj = Number(b.hs_majoration_pct || 0);
    if (!Number.isInteger(maj) || maj < 0 || maj > 200) fail(400, 'Majoration invalide (0 à 200 %).');
    const derniere = db.prepare('SELECT MAX(mois) AS m FROM clotures').get().m;
    if (derniere && b.date_effet <= t.daysInMonth(derniere).at(-1)) {
      fail(409, `La date d’effet doit être postérieure au dernier mois clôturé (${t.monthLabel(derniere)}) : les salaires passés ne sont jamais recalculés.`);
    }
    db.prepare(`INSERT INTO taux_horaires (date_effet, taux, hs_seuil_minutes, hs_majoration_pct, cree_par) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date_effet) DO UPDATE SET taux = excluded.taux, hs_seuil_minutes = excluded.hs_seuil_minutes,
      hs_majoration_pct = excluded.hs_majoration_pct, cree_par = excluded.cree_par, cree_le = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run(b.date_effet, taux, seuil, maj, req.user.id);
    journal(db, req.user.id, 'taux_horaire', { date_effet: b.date_effet, taux, seuil, maj });
    res.json({ ok: true });
  }));

  app.get('/api/parametres', admin, (req, res) => {
    res.json({
      entreprise: getParam(db, 'entreprise'),
      jours_ouvrables: getParam(db, 'jours_ouvrables'),
      email_admin: getParam(db, 'email_admin'),
      notif_pointage: getParam(db, 'notif_pointage') === '1',
      smtp: mailer.smtpConfigure(),
      qr_mode: getParam(db, 'qr_mode'),
      adresse_publique: getParam(db, 'adresse_publique') || require('./telephone').adresseParDefaut() || '',
      adresse_actuelle: `${req.protocol}://${req.get('host')}`,
      adresses_reseau: adressesReseau(),
      gps_lat: getParam(db, 'gps_lat'),
      gps_lon: getParam(db, 'gps_lon'),
      gps_rayon_m: getParam(db, 'gps_rayon_m'),
    });
  });

  app.put('/api/parametres', admin, wrap((req, res) => {
    const b = req.body || {};
    if (b.jours_ouvrables != null) {
      const j = String(b.jours_ouvrables).split(',').filter(Boolean);
      if (!j.every((x) => /^[0-6]$/.test(x))) fail(400, 'Jours ouvrables invalides.');
      setParam(db, 'jours_ouvrables', [...new Set(j)].sort().join(','));
    }
    if (b.email_admin != null) {
      const e = txt(b.email_admin, 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Adresse e-mail invalide.');
      setParam(db, 'email_admin', e);
    }
    if (b.notif_pointage != null) setParam(db, 'notif_pointage', b.notif_pointage === true || b.notif_pointage === '1' ? '1' : '0');
    if (b.qr_mode != null) {
      if (!['dynamique', 'fixe'].includes(b.qr_mode)) fail(400, 'Mode de QR invalide.');
      setParam(db, 'qr_mode', b.qr_mode);
    }
    if (b.adresse_publique != null) {
      const a = txt(b.adresse_publique, 200).replace(/\/+$/, '');
      if (a && !/^https?:\/\/[^\s/]+$/i.test(a)) fail(400, 'Adresse invalide. Exemple : http://192.168.1.20:3000 ou https://pointage.mondomaine.com');
      setParam(db, 'adresse_publique', a);
    }
    if (b.gps_lat != null || b.gps_lon != null || b.gps_rayon_m != null) {
      const vals = [b.gps_lat, b.gps_lon, b.gps_rayon_m].map((v) => (v == null ? '' : String(v).trim()));
      if (vals.some(Boolean)) {
        const [lat, lon, rayon] = vals.map(Number);
        if (!vals.every(Boolean) || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(rayon >= 20 && rayon <= 5000)) {
          fail(400, 'Contrôle GPS : renseignez latitude, longitude et un rayon de 20 à 5 000 m (ou laissez les trois vides).');
        }
      }
      setParam(db, 'gps_lat', vals[0]);
      setParam(db, 'gps_lon', vals[1]);
      setParam(db, 'gps_rayon_m', vals[2]);
    }
    journal(db, req.user.id, 'parametres', b);
    res.json({ ok: true });
  }));

  app.get('/api/utilisateurs', admin, (req, res) => {
    res.json(db.prepare('SELECT id, nom_utilisateur, nom_complet, role, actif, cree_le FROM utilisateurs ORDER BY role, nom_complet').all());
  });

  app.post('/api/utilisateurs', admin, wrap((req, res) => {
    const { nom_complet, nom_utilisateur, mot_de_passe, role } = req.body || {};
    if (!['admin', 'poste'].includes(role)) fail(400, 'Rôle invalide.');
    if (!txt(nom_complet) || !/^[a-zA-Z0-9._-]{3,40}$/.test(nom_utilisateur || '')) fail(400, 'Nom ou identifiant invalide.');
    const err = auth.validerMotDePasse(mot_de_passe);
    if (err) fail(400, err);
    try {
      db.prepare('INSERT INTO utilisateurs (nom_utilisateur, nom_complet, mot_de_passe_hash, role) VALUES (?, ?, ?, ?)')
        .run(nom_utilisateur, txt(nom_complet, 80), auth.hashPassword(mot_de_passe), role);
    } catch { fail(409, 'Cet identifiant existe déjà.'); }
    journal(db, req.user.id, 'utilisateur_creation', { nom_utilisateur, role });
    res.json({ ok: true });
  }));

  app.put('/api/utilisateurs/:id/actif', admin, wrap((req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) fail(400, 'Vous ne pouvez pas désactiver votre propre compte.');
    const actif = req.body?.actif ? 1 : 0;
    const cible = db.prepare('SELECT role, actif FROM utilisateurs WHERE id = ?').get(id);
    if (!cible) fail(404, 'Compte introuvable.');
    if (!actif && cible.role === 'admin' && cible.actif
      && db.prepare("SELECT COUNT(*) AS n FROM utilisateurs WHERE role = 'admin' AND actif = 1").get().n <= 1) {
      fail(409, 'Impossible de désactiver le dernier compte administrateur actif.');
    }
    db.prepare('UPDATE utilisateurs SET actif = ? WHERE id = ?').run(actif, id);
    if (!actif) db.prepare('DELETE FROM sessions WHERE utilisateur_id = ?').run(id);
    journal(db, req.user.id, 'utilisateur_actif', { id, actif });
    res.json({ ok: true });
  }));

  // ---------- Fichiers statiques ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  app.use('/api', (req, res) => res.status(404).json({ erreur: 'Ressource introuvable.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.code).json({ erreur: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'Requête invalide.' });
    console.error(err);
    res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  });

  return app;
}

module.exports = { createApp };
