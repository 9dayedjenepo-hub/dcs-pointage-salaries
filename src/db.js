'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS utilisateurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom_utilisateur TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nom_complet TEXT NOT NULL,
  mot_de_passe_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'poste')),
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
  expire_le TEXT NOT NULL,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS secretaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  telephone TEXT,
  date_embauche TEXT,
  actif INTEGER NOT NULL DEFAULT 1,
  badge_token TEXT NOT NULL UNIQUE,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Une ligne = une présence (arrivée + départ). Départ NULL = pointage ouvert/incomplet.
CREATE TABLE IF NOT EXISTS pointages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secretaire_id INTEGER NOT NULL REFERENCES secretaires(id),
  arrivee_utc TEXT NOT NULL,
  depart_utc TEXT,
  source TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'telephone', 'correction')),
  corrige INTEGER NOT NULL DEFAULT 0,
  annule INTEGER NOT NULL DEFAULT 0,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  appareil_id INTEGER,
  distance_arrivee_m INTEGER,
  distance_depart_m INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pointages_sec ON pointages(secretaire_id, arrivee_utc);

-- Téléphone personnel d'une secrétaire, relié par un code d'activation à usage unique.
CREATE TABLE IF NOT EXISTS appareils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secretaire_id INTEGER NOT NULL REFERENCES secretaires(id),
  token_hash TEXT NOT NULL UNIQUE,
  description TEXT,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dernier_usage TEXT,
  revoque INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS codes_activation (
  code_hash TEXT PRIMARY KEY,
  secretaire_id INTEGER NOT NULL REFERENCES secretaires(id),
  expire_le TEXT NOT NULL,
  utilise INTEGER NOT NULL DEFAULT 0,
  cree_par INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS corrections_pointage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pointage_id INTEGER NOT NULL REFERENCES pointages(id),
  action TEXT NOT NULL CHECK (action IN ('creation', 'modification', 'annulation')),
  ancienne_valeur TEXT,
  nouvelle_valeur TEXT,
  justification TEXT NOT NULL,
  admin_id INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Tarif horaire et règles d'heures supplémentaires, applicables à partir de date_effet.
CREATE TABLE IF NOT EXISTS taux_horaires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_effet TEXT NOT NULL UNIQUE,
  taux INTEGER NOT NULL CHECK (taux > 0),
  hs_seuil_minutes INTEGER,
  hs_majoration_pct INTEGER NOT NULL DEFAULT 0,
  cree_par INTEGER REFERENCES utilisateurs(id),
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS avances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secretaire_id INTEGER NOT NULL REFERENCES secretaires(id),
  montant INTEGER NOT NULL CHECK (montant > 0),
  date_operation TEXT NOT NULL,
  mois_imputation TEXT NOT NULL,
  motif TEXT,
  cree_par INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  annule INTEGER NOT NULL DEFAULT 0,
  annule_par INTEGER REFERENCES utilisateurs(id),
  annule_le TEXT,
  motif_annulation TEXT
);

CREATE TABLE IF NOT EXISTS retenues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secretaire_id INTEGER NOT NULL REFERENCES secretaires(id),
  montant INTEGER NOT NULL CHECK (montant > 0),
  date_operation TEXT NOT NULL,
  mois_imputation TEXT NOT NULL,
  motif TEXT NOT NULL,
  cree_par INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  annule INTEGER NOT NULL DEFAULT 0,
  annule_par INTEGER REFERENCES utilisateurs(id),
  annule_le TEXT,
  motif_annulation TEXT
);

-- Clôture définitive d'un mois : instantané figé du calcul validé.
CREATE TABLE IF NOT EXISTS clotures (
  mois TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  valide_par INTEGER NOT NULL REFERENCES utilisateurs(id),
  valide_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  commentaire TEXT
);

CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY,
  valeur TEXT
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mois TEXT,
  destinataire TEXT,
  sujet TEXT NOT NULL,
  corps TEXT NOT NULL,
  statut TEXT NOT NULL,
  erreur TEXT,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utilisateur_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const DEFAULTS = {
  entreprise: 'Djenepo Couture & Shopping',
  jours_ouvrables: '1,2,3,4,5,6', // lundi à samedi
  email_admin: '',
  notif_pointage: '0', // « 1 » : e-mail à l'administrateur à chaque arrivée et départ
  qr_mode: 'dynamique', // « dynamique » (écran de la boutique, change toutes les 30 s) ou « fixe » (QR imprimé)
  adresse_publique: '', // adresse à laquelle les téléphones joignent le serveur
  gps_lat: '',
  gps_lon: '',
  gps_rayon_m: '',
};

// Bases créées avant le pointage par téléphone : la contrainte CHECK de « source » doit être élargie.
function migrer(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pointages'").get()?.sql || '';
  if (sql.includes("'telephone'")) return;
  // legacy_alter_table : les clés étrangères des autres tables continuent de viser « pointages ».
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN;');
  try {
    db.exec('DROP INDEX IF EXISTS idx_pointages_sec; ALTER TABLE pointages RENAME TO pointages_ancien;');
    db.exec(SCHEMA);
    db.exec(`INSERT INTO pointages (id, secretaire_id, arrivee_utc, depart_utc, source, corrige, annule, cree_le)
      SELECT id, secretaire_id, arrivee_utc, depart_utc, source, corrige, annule, cree_le FROM pointages_ancien;
      DROP TABLE pointages_ancien;`);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'pointages'").get()) migrer(db);
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
  // Secrets du QR de la boutique, générés une fois par installation.
  ins.run('qr_secret', crypto.randomBytes(32).toString('base64url'));
  ins.run('qr_fixe_token', crypto.randomBytes(18).toString('base64url'));
  // Tarif initial : 125 F CFA par heure.
  const n = db.prepare('SELECT COUNT(*) AS n FROM taux_horaires').get().n;
  if (n === 0) {
    db.prepare('INSERT INTO taux_horaires (date_effet, taux, hs_seuil_minutes, hs_majoration_pct) VALUES (?, ?, NULL, 0)')
      .run('2000-01-01', 125);
  }
  return db;
}

function getParam(db, cle) {
  const r = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
  return r ? r.valeur : DEFAULTS[cle];
}

function setParam(db, cle, valeur) {
  db.prepare('INSERT INTO parametres (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur')
    .run(cle, String(valeur));
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function journal(db, utilisateurId, action, details) {
  db.prepare('INSERT INTO journal (utilisateur_id, action, details) VALUES (?, ?, ?)')
    .run(utilisateurId ?? null, action, details == null ? null : JSON.stringify(details));
}

module.exports = { openDb, getParam, setParam, tx, journal };
