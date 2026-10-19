'use strict';
// Tests de l'audit : QR fixe (PDF, impression, stabilité, lisibilité), GPS et journal des tentatives,
// calcul 3 h 30 × 125 F, cumul et avances, cohérence écran / Excel, réouverture d'un mois clôturé, autorisations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const ExcelJS = require('exceljs');
const { openDb, getParam } = require('../src/db');
const { createApp } = require('../src/app');
const { calculerSecretaire } = require('../src/payroll');
const { localToUtcIso } = require('../src/time');

let clock = new Date('2026-09-01T07:00:00Z');
const db = openDb(':memory:');
const app = createApp(db, { now: () => clock });
let server, base;
const cookies = {};
const at = (iso) => { clock = new Date(iso); };

async function brut(qui, method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-DCS': '1' };
  if (cookies[qui]) headers.Cookie = Object.entries(cookies[qui]).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const sc of res.headers.getSetCookie()) {
    const [kv] = sc.split(';');
    const i = kv.indexOf('=');
    (cookies[qui] ||= {})[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return res;
}
async function api(qui, method, url, body) {
  const res = await brut(qui, method, url, body);
  return { status: res.status, data: await res.json() };
}
const fragment = (url, cle) => new URL(url).hash.slice(1).split('&').map((x) => x.split('=')).find(([k]) => k === cle)[1];
const decoderQr = (dataUrl) => {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
};

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const ids = {};

test('préparation', async () => {
  await api('admin', 'POST', '/api/installation', { nom_complet: 'Gérante', nom_utilisateur: 'gerante', mot_de_passe: 'motdepasse-test-1' });
  await api('admin', 'POST', '/api/utilisateurs', { nom_complet: 'Tablette', nom_utilisateur: 'tablette', mot_de_passe: 'tablette-test-1', role: 'poste' });
  await api('poste', 'POST', '/api/connexion', { nom_utilisateur: 'tablette', mot_de_passe: 'tablette-test-1' });
  ids.awa = (await api('admin', 'POST', '/api/secretaires', { nom: 'Traoré', prenom: 'Awa', date_embauche: '2026-09-01' })).data.id;
  ids.bintou = (await api('admin', 'POST', '/api/secretaires', { nom: 'Coulibaly', prenom: 'Bintou', date_embauche: '2026-09-01' })).data.id;
  for (const [k, id] of [['telAwa', ids.awa], ['telBintou', ids.bintou]]) {
    const r = await api('admin', 'POST', `/api/secretaires/${id}/activation`);
    assert.equal((await api(k, 'POST', '/api/telephone/activer', { code: fragment(r.data.url, 'activer') })).status, 200);
  }
});

test('QR fixe : PDF et impression portent le même code, réellement lisible par un lecteur QR', async () => {
  const json = await api('admin', 'GET', '/api/qr-boutique/fixe');
  assert.equal(json.status, 200);
  // Le QR d'impression se décode et contient l'adresse de pointage avec le code fixe
  assert.equal(decoderQr(json.data.qr), json.data.url);
  assert.match(json.data.url, /\/m\.html#c=F\./);
  // Le PDF A4 contient le même code
  const res = await brut('admin', 'GET', '/api/qr-boutique/fixe.pdf');
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.toString('latin1').includes(fragment(json.data.url, 'c')), 'même code fixe dans le PDF');
  assert.ok(pdf.toString('latin1').includes('/MediaBox [0 0 595.28 841.89]'), 'format A4');
  // Identique après actualisation
  const encore = await api('admin', 'GET', '/api/qr-boutique/fixe');
  assert.equal(encore.data.url, json.data.url);
});

test('QR fixe : identique après redémarrage de l’application', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-qr-'));
  const fichier = path.join(dossier, 'base.db');
  let d = openDb(fichier);
  const avant = getParam(d, 'qr_fixe_token');
  d.close();
  d = openDb(fichier);
  assert.equal(getParam(d, 'qr_fixe_token'), avant);
  d.close();
});

test('QR fixe refusé tant que le mode « Fixe » n’est pas enregistré', async () => {
  const code = fragment((await api('admin', 'GET', '/api/qr-boutique/fixe')).data.url, 'c');
  at('2026-09-01T08:00:00Z');
  const r = await api('telAwa', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 400);
  await api('admin', 'PUT', '/api/parametres', { qr_mode: 'fixe' });
});

async function codeFixe() {
  return fragment((await api('admin', 'GET', '/api/qr-boutique/fixe')).data.url, 'c');
}

test('GPS : dans la zone accepté, hors zone refusé, imprécis ou absent → réessayer ; tout est consigné', async () => {
  await api('admin', 'PUT', '/api/parametres', { gps_lat: '12.6392', gps_lon: '-8.0029', gps_rayon_m: '100' });
  const code = await codeFixe();
  at('2026-09-01T09:00:00Z');
  let r = await api('telAwa', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 400);
  assert.equal(r.data.reessayer, true, 'position absente : réessayer');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: { lat: 12.6392, lon: -8.0029, precision: 800 } });
  assert.equal(r.status, 422);
  assert.equal(r.data.reessayer, true, 'position imprécise : réessayer');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: { lat: 12.66, lon: -8.0029, precision: 10 } });
  assert.equal(r.status, 403, 'hors zone (≈ 2,3 km)');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: { lat: 12.6393, lon: -8.0029, precision: 12 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'arrivee');
  assert.equal(r.data.heure, '09:00');

  const t = await api('admin', 'GET', '/api/tentatives');
  const awa = t.data.filter((x) => x.secretaire_id === ids.awa);
  assert.equal(awa.filter((x) => x.resultat === 'refuse').length, 4, 'les 3 refus GPS + le refus en mode dynamique');
  const ok = awa.find((x) => x.resultat === 'accepte');
  assert.equal(ok.type, 'arrivee');
  assert.equal(ok.distance_m, 11);
  assert.equal(ok.precision_m, 12);
  assert.equal(ok.cree_le, '2026-09-01T09:00:00.000Z', 'heure du serveur');
  const horsZone = awa.find((x) => x.distance_m > 1000);
  assert.match(horsZone.motif, /de la boutique/);
});

test('arrivée puis départ ; pas de double pointage dans la minute', async () => {
  const code = await codeFixe();
  const pos = { lat: 12.6392, lon: -8.0029, precision: 10 };
  at('2026-09-01T09:00:30Z');
  let r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: pos });
  assert.equal(r.status, 409, 'double scan refusé');
  at('2026-09-01T12:30:00Z');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: pos });
  assert.equal(r.data.type, 'depart');
  assert.equal(r.data.minutes, 210);
});

test('3 h 30 à 125 F = 437,5 F avant arrondi, 438 F après (arrondi unique sur le mois)', async () => {
  const unitaire = calculerSecretaire({
    secretaire: { id: 1, nom: 'X', prenom: 'Y' },
    pointages: [{ id: 1, arrivee_utc: localToUtcIso('2026-09-01', '09:00'), depart_utc: localToUtcIso('2026-09-01', '12:30') }],
    tauxListe: [{ date_effet: '2000-01-01', taux: 125, hs_seuil_minutes: null, hs_majoration_pct: 0 }],
    avances: [], retenues: [], joursOuvrables: [1, 2, 3, 4, 5, 6], mois: '2026-09', aujourdHui: '2026-10-19',
  });
  assert.equal(unitaire.minutes, 210);
  assert.equal(unitaire.salaire_exact, 437.5);
  assert.equal(unitaire.jours[0].montant_exact, 437.5);
  assert.equal(unitaire.salaire_brut, 438);
  at('2026-09-02T08:00:00Z');
  const p = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data.secretaires.find((s) => s.nom === 'Traoré');
  assert.equal(p.salaire_exact, 437.5);
  assert.equal(p.salaire_brut, 438);
});

test('cumul de plusieurs journées, avances et solde ; écran identique au fichier Excel', async () => {
  const code = await codeFixe();
  const pos = { lat: 12.6392, lon: -8.0029, precision: 10 };
  for (const [jour, arr, dep] of [['02', '08:00', '16:00'], ['03', '08:30', '17:15']]) {
    at(`2026-09-${jour}T${arr}:00Z`);
    await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: pos });
    at(`2026-09-${jour}T${dep}:00Z`);
    await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: pos });
  }
  // Bintou : arrivée sans départ (incomplet, non payé)
  at('2026-09-03T09:00:00Z');
  await api('telBintou', 'POST', '/api/telephone/pointer', { code, position: pos });
  await api('admin', 'POST', '/api/avances', { secretaire_id: ids.awa, montant: 1000, date_operation: '2026-09-03', motif: 'Avance' });

  at('2026-10-02T10:00:00Z');
  const ecran = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  const awa = ecran.secretaires.find((s) => s.nom === 'Traoré');
  const bintou = ecran.secretaires.find((s) => s.nom === 'Coulibaly');
  assert.equal(awa.minutes, 210 + 480 + 525); // 3 h 30 + 8 h + 8 h 45 = 20 h 15
  assert.equal(awa.jours_travailles, 3);
  assert.equal(awa.salaire_exact, 2531.25);
  assert.equal(awa.salaire_brut, 2531);
  assert.equal(awa.net, 1531);
  assert.equal(bintou.minutes, 0);
  assert.equal(bintou.incomplets.length, 1);

  const res = await brut('admin', 'GET', '/api/paie/2026-09/rapport.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Récapitulatif');
  assert.match(String(ws.getCell(4, 1).value), /Rapport généré le/);
  const ligne = (nom) => { let r = null; ws.eachRow((row) => { if (row.getCell(1).value === nom) r = row; }); return r; };
  const xa = ligne('Awa Traoré');
  assert.equal(xa.getCell(2).value, awa.jours_travailles);
  assert.equal(xa.getCell(3).value, 20.25);
  assert.equal(xa.getCell(6).value, 125);
  assert.equal(xa.getCell(7).value, awa.salaire_brut);
  assert.equal(xa.getCell(8).value, awa.avances_total);
  assert.equal(xa.getCell(10).value, awa.net);
  const total = ligne('TOTAL GÉNÉRAL');
  assert.equal(total.getCell(7).value, ecran.totaux.salaire_brut);
  assert.equal(total.getCell(10).value, ecran.totaux.net);
  const pdf = await brut('admin', 'GET', '/api/paie/2026-09/rapport.pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

test('mois clôturé : figé, réouverture exceptionnelle justifiée, version validée archivée', async () => {
  at('2026-10-02T10:00:00Z');
  let r = await api('admin', 'POST', '/api/paie/2026-09/cloturer', { confirmer_incomplets: true });
  assert.equal(r.status, 200);
  const valide = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  r = await api('admin', 'POST', '/api/avances', { secretaire_id: ids.awa, montant: 100, date_operation: '2026-09-05' });
  assert.equal(r.status, 409, 'modification accidentelle refusée');
  r = await api('admin', 'POST', '/api/taux', { date_effet: '2026-09-10', taux: 200 });
  assert.equal(r.status, 409, 'un nouveau tarif ne modifie pas un mois clôturé');

  r = await api('admin', 'POST', '/api/paie/2026-09/rouvrir', { justification: '' });
  assert.equal(r.status, 400, 'justification obligatoire');
  r = await api('poste', 'POST', '/api/paie/2026-09/rouvrir', { justification: 'Tentative non autorisée' });
  assert.equal(r.status, 403, 'réservé aux administrateurs');
  r = await api('admin', 'POST', '/api/paie/2026-09/rouvrir', { justification: 'Départ de Bintou du 03/09 oublié' });
  assert.equal(r.status, 200);

  const archives = (await api('admin', 'GET', '/api/clotures/archives')).data;
  assert.equal(archives.length, 1);
  assert.deepEqual(archives[0].totaux, valide.totaux, 'la version validée est conservée intacte');
  const pdf = await brut('admin', 'GET', `/api/clotures/archives/${archives[0].id}/rapport.pdf`);
  assert.equal(pdf.status, 200);

  // Correction puis nouvelle clôture
  const pts = (await api('admin', 'GET', `/api/pointages?mois=2026-09&secretaire_id=${ids.bintou}`)).data.pointages;
  r = await api('admin', 'PUT', `/api/pointages/${pts[0].id}`, { date: '2026-09-03', arrivee: '09:00', depart: '17:00', justification: 'Départ confirmé par la responsable' });
  assert.equal(r.status, 200);
  r = await api('admin', 'POST', '/api/paie/2026-09/cloturer', {});
  assert.equal(r.status, 200);
  const corrige = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  assert.equal(corrige.statut, 'cloture');
  assert.equal(corrige.secretaires.find((s) => s.nom === 'Coulibaly').salaire_brut, 1000);
});

test('autorisations : le poste et les visiteurs n’accèdent ni aux salaires, ni aux réglages, ni au journal', async () => {
  for (const url of ['/api/paie?mois=2026-09', '/api/tentatives', '/api/parametres', '/api/clotures/archives']) {
    assert.equal((await api('poste', 'GET', url)).status, 403, url);
    assert.equal((await api('visiteur', 'GET', url)).status, 401, url);
  }
  assert.equal((await api('telAwa', 'GET', '/api/paie?mois=2026-09')).status, 401, 'le téléphone d’une secrétaire n’ouvre pas les salaires');
  const r = await api('visiteur', 'POST', '/api/connexion', { nom_utilisateur: 'gerante', mot_de_passe: 'mauvais-mot-de-passe' });
  assert.equal(r.status, 401);
});
