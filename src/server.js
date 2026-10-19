'use strict';
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { openDb, journal } = require('./db');
const { createApp } = require('./app');
const payroll = require('./payroll');
const t = require('./time');

// Sur Railway, la base doit être sur le disque permanent (volume) : sans lui, tout serait effacé au redéploiement.
function fichierBase() {
  if (process.env.DB_FILE) return process.env.DB_FILE;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dcs-pointage.db');
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.error('ERREUR : aucun volume Railway attaché. Ajoutez un volume (point de montage /data) pour conserver les données.');
    process.exit(1);
  }
  return path.join(__dirname, '..', 'data', 'dcs-pointage.db');
}
const fichier = fichierBase();
const db = openDb(fichier);
console.log(`Base de données : ${fichier}`);
const app = createApp(db);

// Calcul automatique de fin de mois : dès le début d'un nouveau mois, la paie du mois écoulé
// est calculée et consignée au journal ; elle apparaît « à valider » sur le tableau de bord.
// La clôture définitive reste une décision de l'administrateur.
function calculAutomatiqueFinDeMois() {
  try {
    const mois = t.previousMonth(t.currentMonth());
    if (payroll.moisCloture(db, mois)) return;
    const deja = db.prepare("SELECT 1 FROM journal WHERE action = 'paie_calculee_auto' AND details LIKE ?").get(`{"mois":"${mois}"%`);
    if (deja) return;
    const r = payroll.calculerMois(db, mois);
    journal(db, null, 'paie_calculee_auto', { mois, totaux: r.totaux });
    console.log(`[paie] Calcul automatique de ${r.libelle_mois} : ${r.totaux.salaire_brut} F brut, ${r.totaux.net} F à payer — en attente de validation.`);
  } catch (e) {
    console.error('[paie] Échec du calcul automatique :', e.message);
  }
}
calculAutomatiqueFinDeMois();
setInterval(calculAutomatiqueFinDeMois, 3600 * 1000).unref();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const serveur = app.listen(port, host, () => {
  console.log(`Djenepo Couture & Shopping — pointage et salaires : http://localhost:${port}`);
  console.log(`Fuseau horaire de calcul : ${t.TZ}`);
  const ips = Object.values(require('node:os').networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`);
  if (ips.length && !process.env.RAILWAY_ENVIRONMENT) console.log(`Adresse(s) pour les téléphones sur le Wi-Fi de la boutique : ${ips.join(', ')}`);
});

// Arrêt propre (redéploiement) : on termine les requêtes en cours puis on ferme la base.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    serveur.close(() => {
      try { db.close(); } catch { /* déjà fermée */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
