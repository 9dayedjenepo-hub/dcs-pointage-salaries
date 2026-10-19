'use strict';
// Scénario complet de bout en bout via l'API HTTP, avec une horloge contrôlée.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let clock = new Date('2026-09-01T08:00:00Z');
const db = openDb(':memory:');
const app = createApp(db, { now: () => clock });
let server, base;
const cookies = {};

async function api(qui, method, url, body, { csrf = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf) headers['X-DCS'] = '1';
  if (cookies[qui]) headers.Cookie = cookies[qui];
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) cookies[qui] = sc.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type };
}
const at = (iso) => { clock = new Date(iso); };

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const ids = {};
const badges = {};

test('installation, sécurité et comptes', async () => {
  let r = await api('admin', 'POST', '/api/installation', { nom_complet: 'Gérante DCS', nom_utilisateur: 'gerante', mot_de_passe: 'motdepasse-test-1' });
  assert.equal(r.status, 200);
  r = await api('x', 'POST', '/api/installation', { nom_complet: 'Pirate', nom_utilisateur: 'pirate', mot_de_passe: 'motdepasse-test-2' });
  assert.equal(r.status, 409, 'une seconde installation est refusée');
  r = await api('anonyme', 'GET', '/api/paie?mois=2026-09');
  assert.equal(r.status, 401);
  r = await api('admin', 'POST', '/api/secretaires', { nom: 'X', prenom: 'Y' }, { csrf: false });
  assert.equal(r.status, 403, 'requête sans en-tête anti-CSRF refusée');
  r = await api('admin', 'POST', '/api/utilisateurs', { nom_complet: 'Tablette boutique', nom_utilisateur: 'poste1', mot_de_passe: 'poste-test-123', role: 'poste' });
  assert.equal(r.status, 200);
  r = await api('poste', 'POST', '/api/connexion', { nom_utilisateur: 'poste1', mot_de_passe: 'poste-test-123' });
  assert.equal(r.status, 200);
  r = await api('poste', 'GET', '/api/paie?mois=2026-09');
  assert.equal(r.status, 403, 'le poste de pointage n’a pas accès aux salaires');
});

test('création de trois secrétaires et badges QR', async () => {
  for (const [k, prenom, nom] of [['A', 'Awa', 'Traoré'], ['B', 'Bintou', 'Coulibaly'], ['C', 'Coumba', 'Diarra']]) {
    const r = await api('admin', 'POST', '/api/secretaires', { nom, prenom, date_embauche: '2026-09-01' });
    ids[k] = r.data.id;
    badges[k] = db.prepare('SELECT badge_token FROM secretaires WHERE id = ?').get(r.data.id).badge_token;
  }
  const qr = await api('admin', 'GET', `/api/secretaires/${ids.A}/qr.png`);
  assert.equal(qr.status, 200);
  assert.equal(qr.type, 'image/png');
});

async function scan(k, iso) {
  at(iso);
  return api('poste', 'POST', '/api/pointage/scan', { code: `DCS:${badges[k]}` });
}

test('pointages par QR sur plusieurs journées', async () => {
  // A : 1er et 2 septembre, 09:00-17:00
  assert.equal((await scan('A', '2026-09-01T09:00:00Z')).data.type, 'arrivee');
  const dbl = await scan('A', '2026-09-01T09:00:30Z');
  assert.equal(dbl.status, 409, 'double scan dans la minute refusé');
  const dep = await scan('A', '2026-09-01T17:00:00Z');
  assert.equal(dep.data.type, 'depart');
  assert.equal(dep.data.minutes, 480);
  await scan('A', '2026-09-02T09:00:00Z');
  await scan('A', '2026-09-02T17:00:00Z');
  // B : 1er septembre avec pause déjeuner, 2 septembre oublie de pointer le départ
  await scan('B', '2026-09-01T08:00:00Z');
  await scan('B', '2026-09-01T12:00:00Z');
  await scan('B', '2026-09-01T13:00:00Z');
  await scan('B', '2026-09-01T17:30:00Z');
  await scan('B', '2026-09-02T08:30:00Z');
  // 3 septembre : B arrive ; l'arrivée de la veille reste incomplète
  const r = await scan('B', '2026-09-03T08:30:00Z');
  assert.equal(r.data.type, 'arrivee');
  assert.equal(r.data.incomplet_precedent, '2026-09-02');
  await scan('B', '2026-09-03T16:30:00Z');
  // C : un jour 10:00-14:00
  await scan('C', '2026-09-04T10:00:00Z');
  await scan('C', '2026-09-04T14:00:00Z');
  const inconnu = await api('poste', 'POST', '/api/pointage/scan', { code: 'DCS:faux-badge' });
  assert.equal(inconnu.status, 404);
});

test('calcul de la paie en cours de mois, avec incomplet signalé', async () => {
  at('2026-09-05T12:00:00Z');
  const { data } = await api('admin', 'GET', '/api/paie?mois=2026-09');
  const [A, B, C] = ['Traoré', 'Coulibaly', 'Diarra'].map((n) => data.secretaires.find((s) => s.nom === n));
  assert.equal(A.minutes, 960); assert.equal(A.salaire_brut, 2000);
  assert.equal(B.minutes, 8.5 * 60 + 8 * 60); assert.equal(B.salaire_brut, 2063); // 16,5 h × 125 = 2 062,5
  assert.equal(B.incomplets.length, 1);
  assert.equal(C.minutes, 240); assert.equal(C.salaire_brut, 500);
  assert.equal(data.totaux.salaire_brut, 2000 + 2063 + 500);
  assert.equal(data.statut, 'provisoire');
});

test('correction exceptionnelle d’un pointage avec justification et historique', async () => {
  const { data } = await api('admin', 'GET', `/api/pointages?mois=2026-09&secretaire_id=${ids.B}`);
  const inc = data.pointages.find((p) => p.statut === 'incomplet');
  let r = await api('admin', 'PUT', `/api/pointages/${inc.id}`, { date: inc.date, arrivee: '08:30', depart: '16:30', justification: '' });
  assert.equal(r.status, 400, 'justification obligatoire');
  r = await api('admin', 'PUT', `/api/pointages/${inc.id}`, { date: inc.date, arrivee: '08:30', depart: '16:30', justification: 'Oubli de pointage au départ, confirmé par la gérante' });
  assert.equal(r.status, 200);
  const h = await api('admin', 'GET', `/api/corrections?pointage_id=${inc.id}`);
  assert.equal(h.data.length, 1);
  assert.equal(h.data[0].ancienne_valeur.depart, null);
  assert.equal(h.data[0].nouvelle_valeur.depart, '2026-09-02 16:30');
  assert.equal(h.data[0].admin, 'Gérante DCS');
});

test('avances et retenues : déduites une seule fois, solde négatif signalé', async () => {
  let r = await api('admin', 'POST', '/api/avances', { secretaire_id: ids.A, montant: 1500, date_operation: '2026-09-03', motif: 'Transport' });
  assert.equal(r.status, 200);
  r = await api('admin', 'POST', '/api/avances', { secretaire_id: ids.C, montant: 2000, date_operation: '2026-09-04' });
  assert.equal(r.status, 200);
  r = await api('admin', 'POST', '/api/retenues', { secretaire_id: ids.A, montant: 100, date_operation: '2026-09-04', motif: '' });
  assert.equal(r.status, 400, 'motif de retenue obligatoire');
  await api('admin', 'POST', '/api/retenues', { secretaire_id: ids.A, montant: 100, date_operation: '2026-09-04', motif: 'Casse matériel (accord écrit)' });
  r = await api('admin', 'POST', '/api/avances', { secretaire_id: ids.A, montant: -5, date_operation: '2026-09-04' });
  assert.equal(r.status, 400);
  // Avance versée en septembre mais imputée sur octobre : jamais déduite en septembre
  await api('admin', 'POST', '/api/avances', { secretaire_id: ids.B, montant: 700, date_operation: '2026-09-30', mois_imputation: '2026-10' });

  at('2026-10-02T10:00:00Z');
  const { data } = await api('admin', 'GET', '/api/paie?mois=2026-09');
  const A = data.secretaires.find((s) => s.nom === 'Traoré');
  const B = data.secretaires.find((s) => s.nom === 'Coulibaly');
  const C = data.secretaires.find((s) => s.nom === 'Diarra');
  assert.equal(A.net, 2000 - 1500 - 100);
  assert.equal(B.salaire_brut, 3063); // 24,5 h après correction
  assert.equal(B.avances_total, 0);
  assert.equal(C.net, -1500);
  assert.equal(C.solde_negatif, true);
  const oct = await api('admin', 'GET', '/api/paie?mois=2026-10');
  assert.equal(oct.data.secretaires.find((s) => s.nom === 'Coulibaly').avances_total, 700);
  assert.equal(oct.data.secretaires.find((s) => s.nom === 'Diarra').net, 0, 'le solde négatif n’est pas reporté');
});

test('rapports PDF et Excel', async () => {
  const pdf = await api('admin', 'GET', '/api/paie/2026-09/rapport.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  const xlsx = await api('admin', 'GET', '/api/paie/2026-09/rapport.xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.data.subarray(0, 2).toString(), 'PK');
});

test('clôture : refus du mois en cours, validation, puis instantané figé', async () => {
  at('2026-10-02T10:00:00Z');
  let r = await api('admin', 'POST', '/api/paie/2026-10/cloturer', {});
  assert.equal(r.status, 400, 'le mois en cours ne peut pas être clôturé');

  // Un nouvel incomplet en septembre bloque la clôture sans confirmation explicite
  await api('admin', 'POST', '/api/pointages', { secretaire_id: ids.C, date: '2026-09-07', arrivee: '09:00', justification: 'Arrivée déclarée sur cahier papier' });
  r = await api('admin', 'POST', '/api/paie/2026-09/cloturer', {});
  assert.equal(r.status, 409);
  r = await api('admin', 'POST', '/api/paie/2026-09/cloturer', { confirmer_incomplets: true, commentaire: 'Paie de septembre validée' });
  assert.equal(r.status, 200);
  assert.equal(r.data.email.statut, 'non_envoye', 'SMTP non configuré en test : e-mail consigné, non envoyé');

  const avant = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  assert.equal(avant.statut, 'cloture');

  // Les modifications sur un mois clôturé sont refusées
  r = await api('admin', 'POST', '/api/avances', { secretaire_id: ids.A, montant: 100, date_operation: '2026-09-10' });
  assert.equal(r.status, 409);
  const pid = db.prepare('SELECT id FROM pointages WHERE secretaire_id = ? LIMIT 1').get(ids.A).id;
  r = await api('admin', 'POST', `/api/pointages/${pid}/annuler`, { justification: 'Test de modification interdite' });
  assert.equal(r.status, 409);
  r = await api('admin', 'POST', '/api/taux', { date_effet: '2026-09-15', taux: 200 });
  assert.equal(r.status, 409, 'un nouveau tarif ne peut pas rétroagir sur un mois clôturé');

  // Un nouveau tarif futur ne modifie pas le mois clôturé
  r = await api('admin', 'POST', '/api/taux', { date_effet: '2026-10-01', taux: 150 });
  assert.equal(r.status, 200);
  const apres = (await api('admin', 'GET', '/api/paie?mois=2026-09')).data;
  assert.deepEqual(apres.totaux, avant.totaux);
  assert.equal(apres.secretaires[0].taux_appliques[0], 125);

  r = await api('admin', 'POST', '/api/paie/2026-09/cloturer', { confirmer_incomplets: true });
  assert.equal(r.status, 409, 'pas de double clôture');
  const hist = await api('admin', 'GET', '/api/clotures');
  assert.equal(hist.data.length, 1);
  const pdf = await api('admin', 'GET', '/api/paie/2026-09/rapport.pdf');
  assert.equal(pdf.status, 200, 'les anciens rapports restent consultables');
  const mails = await api('admin', 'GET', '/api/emails');
  assert.match(mails.data[0].corps, /Montant total restant à payer/);
});

test('nouveau tarif appliqué au mois suivant', async () => {
  at('2026-10-05T07:00:00Z');
  await scan('A', '2026-10-05T09:00:00Z');
  await scan('A', '2026-10-05T17:00:00Z');
  const { data } = await api('admin', 'GET', '/api/paie?mois=2026-10');
  const A = data.secretaires.find((s) => s.nom === 'Traoré');
  assert.equal(A.salaire_brut, 8 * 150);
});
