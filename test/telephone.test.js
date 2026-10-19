'use strict';
// Pointage avec le téléphone des secrétaires : activation, QR dynamique, QR fixe, contrôle GPS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, setParam } = require('../src/db');
const { createApp } = require('../src/app');
const { distanceMetres } = require('../src/telephone');

let clock = new Date('2026-10-05T08:00:00Z');
const db = openDb(':memory:');
const app = createApp(db, { now: () => clock });
let server, base;
const cookies = {};
const at = (iso) => { clock = new Date(iso); };

async function api(qui, method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-DCS': '1' };
  if (cookies[qui]) headers.Cookie = Object.entries(cookies[qui]).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const sc of res.headers.getSetCookie()) {
    const [kv] = sc.split(';');
    const i = kv.indexOf('=');
    (cookies[qui] ||= {})[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { status: res.status, data: await res.json() };
}
const fragment = (url, cle) => new URL(url).hash.slice(1).split('&').map((x) => x.split('=')).find(([k]) => k === cle)[1];

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const ids = {};
let codeActivationAwa;

test('préparation : administrateur, poste, secrétaires', async () => {
  await api('admin', 'POST', '/api/installation', { nom_complet: 'Gérante', nom_utilisateur: 'gerante', mot_de_passe: 'motdepasse-test-1' });
  await api('admin', 'POST', '/api/utilisateurs', { nom_complet: 'Écran boutique', nom_utilisateur: 'ecran', mot_de_passe: 'ecran-test-123', role: 'poste' });
  await api('ecran', 'POST', '/api/connexion', { nom_utilisateur: 'ecran', mot_de_passe: 'ecran-test-123' });
  ids.awa = (await api('admin', 'POST', '/api/secretaires', { nom: 'Traoré', prenom: 'Awa' })).data.id;
  ids.bintou = (await api('admin', 'POST', '/api/secretaires', { nom: 'Coulibaly', prenom: 'Bintou' })).data.id;
});

test('activation du téléphone par QR à usage unique', async () => {
  let r = await api('telAwa', 'GET', '/api/telephone/moi');
  assert.equal(r.data.active, false);
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code: 'x' });
  assert.equal(r.status, 401, 'téléphone non activé refusé');

  r = await api('admin', 'POST', `/api/secretaires/${ids.awa}/activation`);
  assert.equal(r.status, 200);
  assert.match(r.data.qr, /^data:image\/png;base64,/);
  codeActivationAwa = fragment(r.data.url, 'activer');

  r = await api('telAwa', 'POST', '/api/telephone/activer', { code: codeActivationAwa });
  assert.equal(r.status, 200);
  assert.equal(r.data.secretaire, 'Awa Traoré');
  r = await api('telAwa', 'GET', '/api/telephone/moi');
  assert.equal(r.data.active, true);
  assert.equal(r.data.secretaire, 'Awa Traoré');

  r = await api('autreTel', 'POST', '/api/telephone/activer', { code: codeActivationAwa });
  assert.equal(r.status, 400, 'code déjà utilisé refusé');

  r = await api('admin', 'POST', `/api/secretaires/${ids.bintou}/activation`);
  const codeBintou = fragment(r.data.url, 'activer');
  at('2026-10-06T09:00:00Z');
  r = await api('telBintou', 'POST', '/api/telephone/activer', { code: codeBintou });
  assert.equal(r.status, 400, 'code expiré (plus de 24 h) refusé');
  r = await api('admin', 'POST', `/api/secretaires/${ids.bintou}/activation`);
  r = await api('telBintou', 'POST', '/api/telephone/activer', { code: fragment(r.data.url, 'activer') });
  assert.equal(r.status, 200);
});

async function qrBoutique() {
  const r = await api('ecran', 'GET', '/api/qr-boutique');
  assert.equal(r.status, 200);
  return fragment(r.data.url, 'c');
}

test('pointage arrivée / départ avec le QR dynamique de la boutique', async () => {
  at('2026-10-06T09:00:05Z');
  const code = await qrBoutique();
  let r = await api('telAwa', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'arrivee');
  assert.equal(r.data.heure, '09:00');

  // Photo du QR réutilisée 2 heures plus tard : refusée
  at('2026-10-06T11:00:00Z');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 400);
  assert.match(r.data.erreur, /expiré/);

  // QR scanné 45 s après son affichage : accepté (marge de lecture)
  at('2026-10-06T17:00:00Z');
  const codeSoir = await qrBoutique();
  at('2026-10-06T17:00:45Z');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code: codeSoir });
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'depart');
  assert.equal(r.data.minutes, 480);

  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code: 'D999.aaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(r.status, 400, 'QR falsifié refusé');

  r = await api('admin', 'GET', '/api/paie?mois=2026-10');
  const awa = r.data.secretaires.find((s) => s.nom === 'Traoré');
  assert.equal(awa.minutes, 480);
  assert.equal(awa.salaire_brut, 1000);
  const p = await api('admin', 'GET', '/api/pointages?mois=2026-10');
  assert.equal(p.data.pointages[0].source, 'telephone');
});

test('le QR de la boutique n’est délivré qu’au poste connecté', async () => {
  const r = await api('telAwa', 'GET', '/api/qr-boutique');
  assert.equal(r.status, 401);
});

test('affiche PDF du QR fixe : réservée à l’administrateur', async () => {
  const get = (qui) => fetch(`${base}/api/qr-boutique/fixe.pdf`, {
    headers: cookies[qui] ? { Cookie: Object.entries(cookies[qui]).map(([k, v]) => `${k}=${v}`).join('; ') } : {},
  });
  const r = await get('admin');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await get('ecran')).status, 403, 'le poste de pointage ne peut pas la télécharger');
  assert.equal((await get('anonyme')).status, 401);
});

test('mode QR fixe imprimé', async () => {
  await api('admin', 'PUT', '/api/parametres', { qr_mode: 'fixe' });
  const fixe = await api('admin', 'GET', '/api/qr-boutique/fixe');
  const code = fragment(fixe.data.url, 'c');
  at('2026-10-07T08:30:00Z');
  let r = await api('telBintou', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 200);
  assert.equal(r.data.secretaire, 'Bintou Coulibaly');
  // Après régénération, l'ancien QR imprimé ne fonctionne plus
  await api('admin', 'POST', '/api/qr-boutique/fixe/regenerer');
  at('2026-10-07T16:30:00Z');
  r = await api('telBintou', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 400);
  await api('admin', 'PUT', '/api/parametres', { qr_mode: 'dynamique' });
});

test('contrôle GPS : uniquement à proximité de la boutique', async () => {
  // Boutique fictive à Bamako
  let r = await api('admin', 'PUT', '/api/parametres', { gps_lat: '12.6392', gps_lon: '-8.0029', gps_rayon_m: '100' });
  assert.equal(r.status, 200);
  r = await api('admin', 'PUT', '/api/parametres', { gps_lat: '12.6', gps_lon: '', gps_rayon_m: '100' });
  assert.equal(r.status, 400, 'configuration GPS incomplète refusée');
  assert.equal((await api('telAwa', 'GET', '/api/telephone/moi')).data.gps_requis, true);

  at('2026-10-08T09:00:00Z');
  let code = await qrBoutique();
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code });
  assert.equal(r.status, 400, 'position absente refusée');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: { lat: 12.65, lon: -8.0029, precision: 10 } });
  assert.equal(r.status, 403, 'à plus d’un kilomètre : refusé');
  r = await api('telAwa', 'POST', '/api/telephone/pointer', { code, position: { lat: 12.6395, lon: -8.0029, precision: 15 } });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(distanceMetres(12.6392, -8.0029, 12.6395, -8.0029) - 33) < 2);
  const p = await api('admin', 'GET', '/api/pointages?mois=2026-10');
  assert.equal(p.data.pointages[0].distance_arrivee_m, 33);
  await api('admin', 'PUT', '/api/parametres', { gps_lat: '', gps_lon: '', gps_rayon_m: '' });
});

test('nouvelle activation : l’ancien téléphone est désactivé ; révocation par la responsable', async () => {
  let r = await api('admin', 'POST', `/api/secretaires/${ids.awa}/activation`);
  r = await api('nouveauTelAwa', 'POST', '/api/telephone/activer', { code: fragment(r.data.url, 'activer') });
  assert.equal(r.status, 200);
  assert.equal((await api('telAwa', 'GET', '/api/telephone/moi')).data.active, false, 'ancien téléphone désactivé');
  assert.equal((await api('nouveauTelAwa', 'GET', '/api/telephone/moi')).data.active, true);

  const apps = await api('admin', 'GET', '/api/appareils');
  const app2 = apps.data.find((a) => a.secretaire_id === ids.awa);
  r = await api('admin', 'POST', `/api/appareils/${app2.id}/revoquer`);
  assert.equal(r.status, 200);
  at('2026-10-09T09:00:00Z');
  r = await api('nouveauTelAwa', 'POST', '/api/telephone/pointer', { code: await qrBoutique() });
  assert.equal(r.status, 401);
});

test('secrétaire désactivée : pointage téléphone refusé', async () => {
  await api('admin', 'PUT', `/api/secretaires/${ids.bintou}`, { nom: 'Coulibaly', prenom: 'Bintou', actif: false });
  at('2026-10-09T10:00:00Z');
  const r = await api('telBintou', 'POST', '/api/telephone/pointer', { code: await qrBoutique() });
  assert.equal(r.status, 403);
});
