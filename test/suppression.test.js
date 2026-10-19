'use strict';
// Suppression d'une secrétaire : définitive sans données liées, archivage sinon ; protection de l'administrateur.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let clock = new Date('2026-09-01T07:00:00Z');
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
const badge = (id) => db.prepare('SELECT badge_token FROM secretaires WHERE id = ?').get(id).badge_token;

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
  ids.erreur = (await api('admin', 'POST', '/api/secretaires', { nom: 'Doublon', prenom: 'Fiche' })).data.id;
  ids.awa = (await api('admin', 'POST', '/api/secretaires', { nom: 'Traoré', prenom: 'Awa', date_embauche: '2026-09-01' })).data.id;
  // Awa : une journée de 8 h et une avance, puis le mois de septembre est clôturé
  at('2026-09-01T09:00:00Z');
  await api('poste', 'POST', '/api/pointage/scan', { code: `DCS:${badge(ids.awa)}` });
  at('2026-09-01T17:00:00Z');
  await api('poste', 'POST', '/api/pointage/scan', { code: `DCS:${badge(ids.awa)}` });
  await api('admin', 'POST', '/api/avances', { secretaire_id: ids.awa, montant: 300, date_operation: '2026-09-01' });
  const r = await api('admin', 'POST', `/api/secretaires/${ids.erreur}/activation`);
  await api('telErreur', 'POST', '/api/telephone/activer', { code: fragment(r.data.url, 'activer') });
});

test('réservé à l’administrateur', async () => {
  assert.equal((await api('poste', 'DELETE', `/api/secretaires/${ids.erreur}`, { confirmation: 'SUPPRIMER' })).status, 403);
  assert.equal((await api('visiteur', 'DELETE', `/api/secretaires/${ids.erreur}`, { confirmation: 'SUPPRIMER' })).status, 401);
  assert.equal((await api('poste', 'GET', `/api/secretaires/${ids.erreur}/suppression`)).status, 403);
});

test('sans donnée liée : suppression définitive, seulement avec la confirmation SUPPRIMER', async () => {
  const info = await api('admin', 'GET', `/api/secretaires/${ids.erreur}/suppression`);
  assert.equal(info.data.definitive_possible, true);
  let r = await api('admin', 'DELETE', `/api/secretaires/${ids.erreur}`, {});
  assert.equal(r.status, 400, 'sans confirmation : refusé');
  r = await api('admin', 'DELETE', `/api/secretaires/${ids.erreur}`, { confirmation: 'oui' });
  assert.equal(r.status, 400, 'confirmation incorrecte : refusé');
  r = await api('admin', 'DELETE', `/api/secretaires/${ids.erreur}`, { confirmation: 'SUPPRIMER' });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'definitive');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secretaires WHERE id = ?').get(ids.erreur).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appareils WHERE secretaire_id = ?').get(ids.erreur).n, 0);
  assert.equal((await api('telErreur', 'GET', '/api/telephone/moi')).data.active, false, 'téléphone désactivé');
});

test('avec données : archivage, historique et rapports conservés', async () => {
  at('2026-10-02T10:00:00Z');
  assert.equal((await api('admin', 'POST', '/api/paie/2026-09/cloturer', {})).status, 200);
  const avant = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  const ancienBadge = badge(ids.awa);

  const info = await api('admin', 'GET', `/api/secretaires/${ids.awa}/suppression`);
  assert.equal(info.data.definitive_possible, false);
  assert.equal(info.data.pointages, 1);
  assert.equal(info.data.avances, 1);
  assert.deepEqual(info.data.mois_clotures, ['2026-09']);

  const r = await api('admin', 'DELETE', `/api/secretaires/${ids.awa}`, { confirmation: 'SUPPRIMER' });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'archivee');
  // Rien n'est effacé
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pointages WHERE secretaire_id = ?').get(ids.awa).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM avances WHERE secretaire_id = ?').get(ids.awa).n, 1);
  const apres = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  assert.deepEqual(apres.totaux, avant.totaux, 'le mois clôturé est inchangé');
  assert.equal(apres.secretaires[0].salaire_brut, 1000);
  // Elle ne peut plus pointer, ni recevoir de nouvelle avance
  at('2026-10-02T11:00:00Z');
  assert.equal((await api('poste', 'POST', '/api/pointage/scan', { code: `DCS:${ancienBadge}` })).status, 404, 'ancien badge invalidé');
  assert.equal((await api('admin', 'POST', '/api/avances', { secretaire_id: ids.awa, montant: 100, date_operation: '2026-10-02' })).status, 409);
  assert.equal((await api('admin', 'PUT', `/api/secretaires/${ids.awa}`, { nom: 'Traoré', prenom: 'Awa', actif: true })).status, 409, 'pas de réactivation sans restauration');
  // Absente des mois suivants sans activité
  const oct = (await api('admin', 'GET', '/api/paie?mois=2026-10')).data;
  assert.equal(oct.secretaires.some((s) => s.id === ids.awa), false);
  // Toujours listée comme archivée
  const liste = (await api('admin', 'GET', '/api/secretaires')).data;
  assert.equal(liste.find((s) => s.id === ids.awa).archive, 1);
});

test('restauration d’une secrétaire archivée', async () => {
  let r = await api('admin', 'POST', `/api/secretaires/${ids.awa}/restaurer`);
  assert.equal(r.status, 200);
  r = await api('admin', 'PUT', `/api/secretaires/${ids.awa}`, { nom: 'Traoré', prenom: 'Awa', actif: true });
  assert.equal(r.status, 200);
  at('2026-10-05T09:00:00Z');
  r = await api('poste', 'POST', '/api/pointage/scan', { code: `DCS:${badge(ids.awa)}` });
  assert.equal(r.data.type, 'arrivee', 'elle peut de nouveau pointer avec son nouveau badge');
});

test('compte administrateur protégé ; la suppression d’une secrétaire ne touche pas aux comptes', async () => {
  await api('admin', 'POST', '/api/utilisateurs', { nom_complet: 'Adjointe', nom_utilisateur: 'adjointe', mot_de_passe: 'adjointe-test-1', role: 'admin' });
  const users = (await api('admin', 'GET', '/api/utilisateurs')).data;
  const gerante = users.find((u) => u.nom_utilisateur === 'gerante');
  const adjointe = users.find((u) => u.nom_utilisateur === 'adjointe');
  assert.equal((await api('admin', 'PUT', `/api/utilisateurs/${gerante.id}/actif`, { actif: false })).status, 400, 'on ne peut pas désactiver son propre compte');
  assert.equal((await api('poste', 'PUT', `/api/utilisateurs/${gerante.id}/actif`, { actif: false })).status, 403, 'le poste ne peut pas');
  assert.equal((await api('admin', 'PUT', `/api/utilisateurs/${adjointe.id}/actif`, { actif: false })).status, 200, 'un autre administrateur reste actif');
  assert.equal((await api('admin', 'PUT', '/api/utilisateurs/9999/actif', { actif: false })).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM utilisateurs WHERE role = 'admin' AND actif = 1").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM utilisateurs WHERE role = 'admin'").get().n, 2, 'aucun compte supprimé');
});
