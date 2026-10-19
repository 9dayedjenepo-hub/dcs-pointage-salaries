'use strict';
// Notification e-mail à l'administrateur à chaque arrivée et départ (nodemailer simulé).
const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

// Transport simulé : capture les messages, ou échoue si « panne » est vrai.
const envoyes = [];
let panne = false;
nodemailer.createTransport = () => ({
  sendMail: async (m) => {
    if (panne) throw new Error('Connexion SMTP refusée');
    envoyes.push(m);
  },
});
delete process.env.SMTP_HOST;

let clock = new Date('2026-09-07T08:00:00Z');
const db = openDb(':memory:');
const app = createApp(db, { now: () => clock });
let server, base, cookie, badge;

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-DCS': '1' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json() };
}
const at = (iso) => { clock = new Date(iso); };
const nbEmails = () => db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;
// L'envoi se fait en arrière-plan : attendre que la ligne soit consignée.
async function dernierEmail(n) {
  for (let i = 0; i < 100 && nbEmails() < n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(nbEmails(), n);
  return db.prepare('SELECT * FROM emails ORDER BY id DESC LIMIT 1').get();
}
const scanner = () => api('POST', '/api/pointage/scan', { code: `DCS:${badge}` });

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/installation', { nom_complet: 'Gérante DCS', nom_utilisateur: 'gerante', mot_de_passe: 'motdepasse-test-1' });
  const r = await api('POST', '/api/secretaires', { nom: 'Traoré', prenom: 'Awa', date_embauche: '2026-09-01' });
  badge = db.prepare('SELECT badge_token FROM secretaires WHERE id = ?').get(r.data.id).badge_token;
});
test.after(() => server.close());

test('désactivée par défaut : aucun e-mail', async () => {
  assert.equal((await api('GET', '/api/parametres')).data.notif_pointage, false);
  const r = await scanner();
  assert.equal(r.data.type, 'arrivee');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(nbEmails(), 0);
});

test('activée sans SMTP ni adresse : consignée « non envoyé », pointage accepté', async () => {
  let r = await api('PUT', '/api/parametres', { notif_pointage: true });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/parametres')).data.notif_pointage, true);
  at('2026-09-07T12:30:00Z');
  r = await scanner();
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'depart');
  const e = await dernierEmail(1);
  assert.equal(e.statut, 'non_envoye');
  assert.equal(e.mois, null);
  assert.match(e.erreur, /administrateur/);
  assert.match(e.sujet, /Départ de Awa Traoré à 12:30/);
  assert.match(e.corps, /durée de présence : 4 h 30/);
  assert.equal(envoyes.length, 0);

  await api('PUT', '/api/parametres', { email_admin: 'gerante@example.com' });
  at('2026-09-08T08:05:00Z');
  await scanner();
  const e2 = await dernierEmail(2);
  assert.equal(e2.statut, 'non_envoye');
  assert.match(e2.erreur, /SMTP/);
});

test('SMTP configuré : e-mail envoyé à l’administrateur', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  at('2026-09-08T17:00:00Z');
  const r = await scanner();
  assert.equal(r.data.type, 'depart');
  const e = await dernierEmail(3);
  assert.equal(e.statut, 'envoye');
  assert.equal(e.destinataire, 'gerante@example.com');
  assert.equal(envoyes.length, 1);
  assert.equal(envoyes[0].to, 'gerante@example.com');
  assert.match(envoyes[0].subject, /Départ de Awa Traoré à 17:00/);
  assert.match(envoyes[0].text, /le 08\/09\/2026 à 17:00 \(heure de Bamako\)/);
  assert.match(envoyes[0].text, /Arrivée à 08:05 — durée de présence : 8 h 55/);

  at('2026-09-09T07:58:00Z');
  await scanner();
  await dernierEmail(4);
  assert.match(envoyes[1].subject, /Arrivée de Awa Traoré à 07:58/);
  assert.doesNotMatch(envoyes[1].text, /durée/);
});

test('panne SMTP : le pointage réussit, l’échec est consigné', async () => {
  panne = true;
  at('2026-09-09T16:00:00Z');
  const r = await scanner();
  assert.equal(r.status, 200);
  assert.equal(r.data.type, 'depart');
  const e = await dernierEmail(5);
  assert.equal(e.statut, 'echec');
  assert.match(e.erreur, /SMTP refusée/);
  panne = false;
});

test('désactivation et historique', async () => {
  await api('PUT', '/api/parametres', { notif_pointage: false });
  at('2026-09-10T08:00:00Z');
  await scanner();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(nbEmails(), 5);
  const h = await api('GET', '/api/emails');
  assert.equal(h.data.length, 5);
  assert.ok(h.data[0].id > h.data[1].id, 'du plus récent au plus ancien');
});
