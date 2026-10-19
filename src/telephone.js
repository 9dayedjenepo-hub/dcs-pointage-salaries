'use strict';
// Pointage avec le téléphone personnel des secrétaires.
//
// 1. Activation (une seule fois) : la responsable affiche un QR d'activation à usage unique (valable 24 h) ;
//    la secrétaire le scanne avec son téléphone, qui reçoit un jeton d'appareil (cookie HttpOnly) relié à son nom.
// 2. Pointage : la secrétaire scanne le QR de la boutique avec son téléphone.
//    - mode « dynamique » : QR affiché sur l'écran/tablette de la boutique, renouvelé toutes les 30 s
//      (une photo du QR ne permet pas de pointer plus tard depuis ailleurs) ;
//    - mode « fixe » : QR imprimé et affiché au mur.
//    Contrôle GPS facultatif : position du téléphone dans un rayon autour de la boutique.
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { getParam, setParam, journal } = require('./db');
const t = require('./time');

const COOKIE = 'dcs_appareil';
const DUREE_APPAREIL_S = 2 * 365 * 24 * 3600;
const DUREE_ACTIVATION_MS = 24 * 3600 * 1000;
const PERIODE_QR_MS = 30 * 1000;
const TOLERANCE_PERIODES = 2; // QR accepté jusqu'à 60 à 90 s après son affichage
const PRECISION_MAX_M = 150; // au-delà, la position est jugée trop imprécise : on demande de réessayer
const MAX_ECHECS = 10;
const FENETRE_ECHECS_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const echecs = new Map();

function limiter(req, fail) {
  const e = echecs.get(req.ip);
  if (e && Date.now() - e.depuis < FENETRE_ECHECS_MS && e.n >= MAX_ECHECS) fail(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
}
function noterEchec(req) {
  const e = echecs.get(req.ip);
  if (!e || Date.now() - e.depuis > FENETRE_ECHECS_MS) echecs.set(req.ip, { n: 1, depuis: Date.now() });
  else e.n += 1;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function distanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function codeDynamique(db, periode) {
  const sig = crypto.createHmac('sha256', getParam(db, 'qr_secret')).update(`boutique:${periode}`).digest('base64url').slice(0, 22);
  return `D${periode}.${sig}`;
}

function verifierCodeBoutique(db, code, instant) {
  const mode = getParam(db, 'qr_mode');
  if (mode === 'fixe') {
    const attendu = `F.${getParam(db, 'qr_fixe_token')}`;
    return code.length === attendu.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(attendu)) ? 'ok' : 'invalide';
  }
  const m = /^D(\d+)\.[A-Za-z0-9_-]{22}$/.exec(code);
  if (!m) return code.startsWith('F.') ? 'mauvais_mode' : 'invalide';
  const periode = Number(m[1]);
  const courante = Math.floor(instant.getTime() / PERIODE_QR_MS);
  const recu = Buffer.from(code);
  const attendu = Buffer.from(codeDynamique(db, periode));
  if (recu.length !== attendu.length || !crypto.timingSafeEqual(recu, attendu)) return 'invalide';
  if (periode > courante || courante - periode > TOLERANCE_PERIODES) return 'expire';
  return 'ok';
}

function gpsConfig(db) {
  const lat = parseFloat(getParam(db, 'gps_lat'));
  const lon = parseFloat(getParam(db, 'gps_lon'));
  const rayon = parseFloat(getParam(db, 'gps_rayon_m'));
  if ([lat, lon, rayon].some((x) => Number.isNaN(x))) return null;
  return { lat, lon, rayon };
}

// Adresse publique fournie par l'environnement : PUBLIC_URL, ou le domaine https attribué par Railway.
function adresseParDefaut() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return '';
}

function adresseBase(db, req) {
  const configuree = (getParam(db, 'adresse_publique') || adresseParDefaut()).trim().replace(/\/+$/, '');
  return configuree || `${req.protocol}://${req.get('host')}`;
}

function estAdresseLocale(base) {
  try {
    const h = new URL(base).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch { return true; }
}

async function qrDataUrl(texte) {
  return QRCode.toDataURL(texte, { width: 420, margin: 2, errorCorrectionLevel: 'M' });
}

function afficheQrPdf(entreprise, png, base, url) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `QR de pointage — ${entreprise}`, Subject: url } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const largeur = doc.page.width - 100;
    const centre = { width: largeur, align: 'center' };
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#7a1f3d').text(entreprise, 50, 60, centre);
    doc.moveDown(0.4).font('Helvetica').fontSize(18).fillColor('#222').text('Pointage des secrétaires', centre);
    const cote = 340;
    doc.image(png, (doc.page.width - cote) / 2, 170, { width: cote, height: cote });
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#222')
      .text('Scannez ce QR code avec votre téléphone', 50, 540, centre);
    doc.moveDown(0.3).font('Helvetica').fontSize(16).text('à votre arrivée et à votre départ', centre);
    doc.moveDown(1.2).fontSize(11).fillColor('#555')
      .text('Première utilisation : demandez à la responsable d’activer votre téléphone.', centre);
    doc.font('Helvetica').fontSize(8).fillColor('#999')
      .text(base.replace(/^https?:\/\//, ''), 50, doc.page.height - 70, centre);
    doc.end();
  });
}

function register(app, db,{ now, fail, wrap, txt, admin, posteOuAdmin, enregistrerPassage }) {
  const cookieAppareil = (req, valeur, maxAge) => {
    const secure = req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return `${COOKIE}=${encodeURIComponent(valeur)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  };

  function appareilConnecte(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    return db.prepare(`SELECT a.id AS appareil_id, s.* FROM appareils a JOIN secretaires s ON s.id = a.secretaire_id
      WHERE a.token_hash = ? AND a.revoque = 0`).get(sha256(token)) || null;
  }

  // ----- Administration : activation des téléphones -----
  app.post('/api/secretaires/:id/activation', admin, wrap(async (req, res) => {
    const sec = db.prepare('SELECT * FROM secretaires WHERE id = ?').get(Number(req.params.id));
    if (!sec) fail(404, 'Secrétaire introuvable.');
    if (!sec.actif) fail(409, 'Cette secrétaire est inactive.');
    const code = crypto.randomBytes(15).toString('base64url');
    const expire = new Date(now().getTime() + DUREE_ACTIVATION_MS).toISOString();
    db.prepare('UPDATE codes_activation SET utilise = 1 WHERE secretaire_id = ? AND utilise = 0').run(sec.id);
    db.prepare('INSERT INTO codes_activation (code_hash, secretaire_id, expire_le, cree_par) VALUES (?, ?, ?, ?)')
      .run(sha256(code), sec.id, expire, req.user.id);
    journal(db, req.user.id, 'activation_telephone_code', { secretaire_id: sec.id });
    const base = adresseBase(db, req);
    const url = `${base}/m.html#activer=${code}`;
    res.json({ url, qr: await qrDataUrl(url), expire_le: expire, adresse_locale: estAdresseLocale(base) });
  }));

  app.get('/api/appareils', admin, (req, res) => {
    res.json(db.prepare(`SELECT a.id, a.secretaire_id, a.description, a.cree_le, a.dernier_usage FROM appareils a
      WHERE a.revoque = 0 ORDER BY a.cree_le DESC`).all());
  });

  app.post('/api/appareils/:id/revoquer', admin, wrap((req, res) => {
    const r = db.prepare('UPDATE appareils SET revoque = 1 WHERE id = ? AND revoque = 0').run(Number(req.params.id));
    if (!r.changes) fail(404, 'Téléphone introuvable ou déjà désactivé.');
    journal(db, req.user.id, 'telephone_revoque', { appareil_id: Number(req.params.id) });
    res.json({ ok: true });
  }));

  // ----- QR de la boutique -----
  app.get('/api/qr-boutique', posteOuAdmin, wrap(async (req, res) => {
    const instant = now();
    const base = adresseBase(db, req);
    const mode = getParam(db, 'qr_mode');
    let code;
    let expireDans = null;
    if (mode === 'fixe') code = `F.${getParam(db, 'qr_fixe_token')}`;
    else {
      const periode = Math.floor(instant.getTime() / PERIODE_QR_MS);
      code = codeDynamique(db, periode);
      expireDans = Math.ceil(((periode + 1) * PERIODE_QR_MS - instant.getTime()) / 1000);
    }
    const url = `${base}/m.html#c=${code}`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mode, url, qr: await qrDataUrl(url), renouvele_dans_s: expireDans, adresse_locale: estAdresseLocale(base) });
  }));

  app.get('/api/qr-boutique/fixe', admin, wrap(async (req, res) => {
    const base = adresseBase(db, req);
    const url = `${base}/m.html#c=F.${getParam(db, 'qr_fixe_token')}`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url, qr: await qrDataUrl(url), actif: getParam(db, 'qr_mode') === 'fixe', adresse_locale: estAdresseLocale(base) });
  }));

  // Affiche A4 à imprimer et coller dans la boutique.
  app.get('/api/qr-boutique/fixe.pdf', admin, wrap(async (req, res) => {
    const base = adresseBase(db, req);
    const url = `${base}/m.html#c=F.${getParam(db, 'qr_fixe_token')}`;
    const png = await QRCode.toBuffer(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' });
    const pdf = await afficheQrPdf(getParam(db, 'entreprise'), png, base, url);
    res.setHeader('Cache-Control', 'no-store');
    res.type('pdf').setHeader('Content-Disposition', 'attachment; filename="DCS_QR_pointage_boutique.pdf"');
    res.send(pdf);
  }));

  app.post('/api/qr-boutique/fixe/regenerer', admin, wrap((req, res) => {
    setParam(db, 'qr_fixe_token', crypto.randomBytes(18).toString('base64url'));
    journal(db, req.user.id, 'qr_fixe_regenere', null);
    res.json({ ok: true });
  }));

  // ----- Côté téléphone de la secrétaire -----
  app.post('/api/telephone/activer', wrap((req, res) => {
    limiter(req, fail);
    const code = txt(req.body?.code, 100);
    const act = code && db.prepare(`SELECT c.*, s.prenom, s.nom, s.actif FROM codes_activation c JOIN secretaires s ON s.id = c.secretaire_id
      WHERE c.code_hash = ?`).get(sha256(code));
    if (!act || act.utilise || act.expire_le < now().toISOString() || !act.actif) {
      noterEchec(req);
      fail(400, 'Code d’activation invalide, déjà utilisé ou expiré. Demandez un nouveau QR d’activation à la responsable.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE codes_activation SET utilise = 1 WHERE code_hash = ?').run(act.code_hash);
      // Un seul téléphone par secrétaire : l'ancien est désactivé.
      db.prepare('UPDATE appareils SET revoque = 1 WHERE secretaire_id = ? AND revoque = 0').run(act.secretaire_id);
      db.prepare('INSERT INTO appareils (secretaire_id, token_hash, description) VALUES (?, ?, ?)')
        .run(act.secretaire_id, sha256(token), txt(req.get('user-agent'), 200));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    journal(db, null, 'telephone_active', { secretaire_id: act.secretaire_id });
    res.setHeader('Set-Cookie', cookieAppareil(req, token, DUREE_APPAREIL_S));
    res.json({ ok: true, secretaire: `${act.prenom} ${act.nom}` });
  }));

  app.get('/api/telephone/moi', (req, res) => {
    const sec = appareilConnecte(req);
    const gps = gpsConfig(db);
    if (!sec) return res.json({ active: false, entreprise: getParam(db, 'entreprise') });
    const aujourdHui = t.today(now());
    const pts = db.prepare(`SELECT * FROM pointages WHERE secretaire_id = ? AND annule = 0 AND arrivee_utc >= ? ORDER BY arrivee_utc`)
      .all(sec.id, new Date(Date.parse(aujourdHui) - 86400000).toISOString())
      .filter((p) => t.localDate(p.arrivee_utc) === aujourdHui);
    res.json({
      active: true,
      entreprise: getParam(db, 'entreprise'),
      secretaire: `${sec.prenom} ${sec.nom}`,
      actif: !!sec.actif,
      date: aujourdHui,
      present: pts.some((p) => !p.depart_utc),
      presences: pts.map((p) => ({ arrivee: t.localTime(p.arrivee_utc), depart: p.depart_utc ? t.localTime(p.depart_utc) : null })),
      gps_requis: !!gps,
    });
  });

  app.post('/api/telephone/pointer', wrap((req, res) => {
    limiter(req, fail);
    const sec = appareilConnecte(req);
    // Chaque tentative est consignée (heure serveur, résultat, distance, précision GPS).
    const trace = { secretaire_id: sec?.id ?? null, appareil_id: sec?.appareil_id ?? null, distance: null, precision: null };
    const consigner = (resultat, extra = {}) => db.prepare(`INSERT INTO tentatives_pointage
      (cree_le, secretaire_id, appareil_id, source, resultat, type, motif, distance_m, precision_m, pointage_id, ip)
      VALUES (?, ?, ?, 'telephone', ?, ?, ?, ?, ?, ?, ?)`).run(now().toISOString(), trace.secretaire_id, trace.appareil_id,
      resultat, extra.type ?? null, extra.motif ?? null, trace.distance, trace.precision, extra.pointage_id ?? null, req.ip ?? null);
    try {
      if (!sec) fail(401, 'Ce téléphone n’est pas activé. Demandez le QR d’activation à la responsable.');
      const code = txt(req.body?.code, 100);
      const verif = verifierCodeBoutique(db, code, now());
      if (verif !== 'ok') {
        noterEchec(req);
        fail(400, {
          expire: 'Ce QR code a expiré. Scannez le QR affiché en ce moment sur l’écran de la boutique.',
          mauvais_mode: 'Ce QR code n’est plus valable. Scannez le QR de pointage affiché à la boutique.',
          invalide: 'QR code non reconnu. Scannez le QR de pointage de la boutique.',
        }[verif]);
      }
      const gps = gpsConfig(db);
      if (gps) {
        const p = req.body?.position;
        const lat = Number(p?.lat);
        const lon = Number(p?.lon);
        if (!p || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          fail(400, 'Position introuvable : activez la localisation du téléphone, puis réessayez.', { reessayer: true });
        }
        const precision = Math.max(0, Number(p.precision) || 0);
        trace.precision = Math.round(precision);
        trace.distance = Math.round(distanceMetres(gps.lat, gps.lon, lat, lon));
        if (precision > PRECISION_MAX_M) {
          fail(422, `Position GPS trop imprécise (± ${trace.precision} m). Patientez quelques secondes, de préférence près d’une porte ou d’une fenêtre, puis réessayez.`, { reessayer: true });
        }
        if (trace.distance > gps.rayon + Math.min(precision, 50)) {
          fail(403, `Vous êtes à environ ${trace.distance} m de la boutique. Le pointage n’est possible que sur place (rayon ${gps.rayon} m).`, { reessayer: true });
        }
      }
      const r = enregistrerPassage(sec, { source: 'telephone', appareilId: sec.appareil_id, distance: trace.distance });
      db.prepare('UPDATE appareils SET dernier_usage = ? WHERE id = ?').run(now().toISOString(), sec.appareil_id);
      consigner('accepte', { type: r.type, pointage_id: r.pointage_id, motif: gps ? 'QR et position vérifiés' : 'QR vérifié (contrôle GPS désactivé)' });
      journal(db, null, `telephone_${r.type}`, { secretaire_id: sec.id, pointage_id: r.pointage_id, distance: trace.distance });
      res.json({ ...r, distance_m: trace.distance });
    } catch (e) {
      consigner('refuse', { motif: e.message });
      throw e;
    }
  }));

  app.get('/api/tentatives', admin, (req, res) => {
    const rows = db.prepare(`SELECT tp.*, s.prenom || ' ' || s.nom AS secretaire FROM tentatives_pointage tp
      LEFT JOIN secretaires s ON s.id = tp.secretaire_id ORDER BY tp.id DESC LIMIT 300`).all();
    res.json(rows.map((r) => ({ ...r, cree_le_local: t.localDateTime(r.cree_le) })));
  });
}

module.exports = { register, adresseParDefaut, distanceMetres, codeDynamique, verifierCodeBoutique, PERIODE_QR_MS };
