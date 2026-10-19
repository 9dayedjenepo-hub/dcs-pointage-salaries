'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculerSecretaire, fusionner } = require('../src/payroll');
const { localToUtcIso } = require('../src/time');

const TAUX = [{ date_effet: '2000-01-01', taux: 125, hs_seuil_minutes: null, hs_majoration_pct: 0 }];
const LUN_SAM = [1, 2, 3, 4, 5, 6];
let seq = 1;
const pt = (date, arr, dep) => ({ id: seq++, arrivee_utc: localToUtcIso(date, arr), depart_utc: dep ? localToUtcIso(date, dep) : null });
const sec = (id = 1, extra = {}) => ({ id, nom: `Nom${id}`, prenom: `Prénom${id}`, ...extra });

function calc(pointages, opts = {}) {
  return calculerSecretaire({
    secretaire: opts.secretaire || sec(),
    pointages,
    tauxListe: opts.taux || TAUX,
    avances: opts.avances || [],
    retenues: opts.retenues || [],
    joursOuvrables: opts.jours || LUN_SAM,
    mois: opts.mois || '2026-09',
    aujourdHui: opts.aujourdHui || '2026-10-17',
  });
}

// Les jours ouvrables (lundi-samedi) de septembre 2026 : 26 jours.
const joursOuvresSept = () => {
  const out = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    if (new Date(date + 'T12:00:00Z').getUTCDay() !== 0) out.push(date);
  }
  return out;
};

test('exemple du cahier des charges : 09 h 00 → 17 h 00 = 8 h = 1 000 F', () => {
  const r = calc([pt('2026-09-01', '09:00', '17:00')]);
  assert.equal(r.minutes, 480);
  assert.equal(r.salaire_brut, 1000);
  assert.equal(r.jours[0].montant, 1000);
  assert.equal(r.jours_travailles, 1);
});

test('26 jours × 8 h = 208 h = 26 000 F, sans absence', () => {
  const jours = joursOuvresSept();
  assert.equal(jours.length, 26);
  const r = calc(jours.map((d) => pt(d, '09:00', '17:00')));
  assert.equal(r.minutes, 208 * 60);
  assert.equal(r.salaire_brut, 26000);
  assert.equal(r.jours_travailles, 26);
  assert.equal(r.absences, 0);
  assert.equal(r.net, 26000);
});

test('trois secrétaires : 180 h / 200 h / 160 h → 22 500 / 25 000 / 20 000 F, total 67 500 F', () => {
  const jours = joursOuvresSept();
  // A : 20 jours × 9 h = 180 h ; B : 25 jours × 8 h = 200 h ; C : 20 jours × 8 h = 160 h
  const a = calc(jours.slice(0, 20).map((d) => pt(d, '08:00', '17:00')), { secretaire: sec(1) });
  const b = calc(jours.slice(0, 25).map((d) => pt(d, '09:00', '17:00')), { secretaire: sec(2) });
  const c = calc(jours.slice(0, 20).map((d) => pt(d, '09:00', '17:00')), { secretaire: sec(3) });
  assert.deepEqual([a.minutes / 60, b.minutes / 60, c.minutes / 60], [180, 200, 160]);
  assert.deepEqual([a.salaire_brut, b.salaire_brut, c.salaire_brut], [22500, 25000, 20000]);
  assert.equal(a.salaire_brut + b.salaire_brut + c.salaire_brut, 67500);
  assert.equal(a.absences, 6);
  assert.equal(b.absences, 1);
});

test('plusieurs présences dans la journée (pause déjeuner) sont additionnées', () => {
  const r = calc([pt('2026-09-02', '08:00', '12:00'), pt('2026-09-02', '13:00', '17:30')]);
  assert.equal(r.minutes, 8 * 60 + 30);
  assert.equal(r.salaire_brut, 1063); // 8,5 h × 125 = 1 062,5 → arrondi au franc
  assert.equal(r.jours_travailles, 1);
});

test('les heures qui se chevauchent ne sont jamais comptées deux fois', () => {
  const r = calc([pt('2026-09-03', '09:00', '13:00'), pt('2026-09-03', '11:00', '15:00'), pt('2026-09-03', '12:00', '12:30')]);
  assert.equal(r.minutes, 6 * 60);
  assert.equal(r.salaire_brut, 750);
  assert.deepEqual(fusionner([[5, 10], [1, 3], [2, 6]]), [[1, 10]]);
});

test('arrivée sans départ un jour passé : 0 h, signalée incomplète, pas une absence', () => {
  const r = calc([pt('2026-09-01', '09:00', '17:00'), pt('2026-09-02', '09:00', null)]);
  assert.equal(r.minutes, 480);
  assert.equal(r.salaire_brut, 1000);
  assert.equal(r.incomplets.length, 1);
  assert.equal(r.incomplets[0].date, '2026-09-02');
  assert.equal(r.jours.find((j) => j.date === '2026-09-02').statut, 'incomplet');
  assert.equal(r.jours_travailles, 1);
  assert.ok(!r.dates_absence.includes('2026-09-02'));
});

test('journée avec une présence complète et une incomplète : seule la complète compte', () => {
  const r = calc([pt('2026-09-04', '08:00', '12:00'), pt('2026-09-04', '13:00', null)]);
  assert.equal(r.minutes, 240);
  assert.equal(r.salaire_brut, 500);
  assert.equal(r.jours[0].statut, 'incomplet');
});

test('arrivée sans départ le jour même : « en cours », non comptée, non signalée', () => {
  const r = calc([pt('2026-10-17', '09:00', null)], { mois: '2026-10', aujourdHui: '2026-10-17' });
  assert.equal(r.minutes, 0);
  assert.equal(r.incomplets.length, 0);
  assert.equal(r.jours[0].statut, 'en_cours');
});

test('avances déduites une fois ; solde négatif signalé', () => {
  const p = [pt('2026-09-01', '09:00', '17:00'), pt('2026-09-02', '09:00', '17:00')];
  const r = calc(p, { avances: [{ id: 1, montant: 500 }, { id: 2, montant: 300 }], retenues: [{ id: 1, montant: 200 }] });
  assert.equal(r.salaire_brut, 2000);
  assert.equal(r.avances_total, 800);
  assert.equal(r.retenues_total, 200);
  assert.equal(r.net, 1000);
  assert.equal(r.solde_negatif, false);

  const n = calc(p, { avances: [{ id: 3, montant: 5000 }] });
  assert.equal(n.net, -3000);
  assert.equal(n.solde_negatif, true);
});

test('changement de tarif en cours de mois : chaque jour au tarif en vigueur', () => {
  const taux = [...TAUX, { date_effet: '2026-09-15', taux: 150, hs_seuil_minutes: null, hs_majoration_pct: 0 }];
  const r = calc([pt('2026-09-14', '09:00', '17:00'), pt('2026-09-15', '09:00', '17:00')], { taux });
  assert.equal(r.salaire_brut, 1000 + 1200);
  assert.deepEqual(r.taux_appliques, [125, 150]);
});

test('heures supplémentaires configurées : au-delà de 8 h, majorées de 25 %', () => {
  const taux = [{ date_effet: '2000-01-01', taux: 125, hs_seuil_minutes: 480, hs_majoration_pct: 25 }];
  const r = calc([pt('2026-09-01', '08:00', '18:00')], { taux });
  assert.equal(r.minutes, 600);
  assert.equal(r.minutes_hs, 120);
  // 10 h × 125 + 2 h × 125 × 25 % = 1 250 + 62,5 → 1 313
  assert.equal(r.salaire_brut, 1313);
});

test('heures supplémentaires sans configuration : non calculées', () => {
  const r = calc([pt('2026-09-01', '08:00', '18:00')]);
  assert.equal(r.minutes_hs, 0);
  assert.equal(r.salaire_brut, 1250);
});

test('absences : jours ouvrables écoulés sans pointage, à partir de la date d’embauche', () => {
  const r = calc([], { secretaire: sec(1, { date_embauche: '2026-09-28' }) });
  assert.deepEqual(r.dates_absence, ['2026-09-28', '2026-09-29', '2026-09-30']);
  const enCours = calc([], { mois: '2026-10', aujourdHui: '2026-10-05' });
  // 1er-4 octobre 2026 : jeudi, vendredi, samedi (dimanche exclu) ; le jour même n'est pas compté
  assert.equal(enCours.absences, 3);
});

test('départ antérieur à l’arrivée : ignoré et signalé comme anomalie', () => {
  const p = { id: 999, arrivee_utc: localToUtcIso('2026-09-01', '17:00'), depart_utc: localToUtcIso('2026-09-01', '09:00') };
  const r = calc([p]);
  assert.equal(r.minutes, 0);
  assert.equal(r.anomalies.length, 1);
});

test('fuseau Africa/Bamako : conversion locale ↔ UTC', () => {
  assert.equal(localToUtcIso('2026-09-01', '09:00'), '2026-09-01T09:00:00.000Z');
});
