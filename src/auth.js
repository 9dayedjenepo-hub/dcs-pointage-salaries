'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'dcs_session';
const DUREE_SESSION_MS = 12 * 3600 * 1000;
const echecs = new Map(); // clé ip|utilisateur -> { n, depuis }
const MAX_ECHECS = 5;
const FENETRE_ECHECS_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

function validerMotDePasse(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  return null;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bloque(cle) {
  const e = echecs.get(cle);
  if (!e) return false;
  if (Date.now() - e.depuis > FENETRE_ECHECS_MS) { echecs.delete(cle); return false; }
  return e.n >= MAX_ECHECS;
}

function noterEchec(cle) {
  const e = echecs.get(cle);
  if (!e || Date.now() - e.depuis > FENETRE_ECHECS_MS) echecs.set(cle, { n: 1, depuis: Date.now() });
  else e.n += 1;
}

function login(db, req, res, nomUtilisateur, motDePasse) {
  const cle = `${req.ip}|${String(nomUtilisateur || '').toLowerCase()}`;
  if (bloque(cle)) return { erreur: 'Trop de tentatives. Réessayez dans 15 minutes.', code: 429 };
  const u = db.prepare('SELECT * FROM utilisateurs WHERE nom_utilisateur = ? AND actif = 1').get(String(nomUtilisateur || ''));
  if (!u || !bcrypt.compareSync(String(motDePasse || ''), u.mot_de_passe_hash)) {
    noterEchec(cle);
    return { erreur: 'Identifiants incorrects.', code: 401 };
  }
  echecs.delete(cle);
  const token = crypto.randomBytes(32).toString('base64url');
  const expire = new Date(Date.now() + DUREE_SESSION_MS).toISOString();
  db.prepare('DELETE FROM sessions WHERE expire_le < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, utilisateur_id, expire_le) VALUES (?, ?, ?)').run(sha256(token), u.id, expire);
  res.setHeader('Set-Cookie', cookieHeader(req, token, DUREE_SESSION_MS / 1000));
  return { utilisateur: publicUser(u) };
}

function cookieHeader(req, value, maxAge) {
  const secure = req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function logout(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

function publicUser(u) {
  return { id: u.id, nom_utilisateur: u.nom_utilisateur, nom_complet: u.nom_complet, role: u.role };
}

// Charge l'utilisateur connecté (req.user) et protège contre le CSRF.
function middleware(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN utilisateurs u ON u.id = s.utilisateur_id
        WHERE s.token_hash = ? AND s.expire_le > ? AND u.actif = 1`).get(sha256(token), new Date().toISOString());
      if (row) req.user = publicUser(row);
    }
    // Les requêtes modifiantes doivent porter un en-tête personnalisé (impossible en cross-site sans CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path.startsWith('/api/')
      && req.get('X-DCS') !== '1') {
      return res.status(403).json({ erreur: 'Requête refusée.' });
    }
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ erreur: 'Veuillez vous connecter.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ erreur: 'Accès réservé.' });
    next();
  };
}

module.exports = { hashPassword, validerMotDePasse, login, logout, middleware, requireRole, publicUser };
