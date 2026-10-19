'use strict';
// Envoi du récapitulatif mensuel à l'administrateur après validation de la paie.
const nodemailer = require('nodemailer');
const { getParam } = require('./db');
const { formatHeures } = require('./payroll');
const { fmtF } = require('./reports');

function smtpConfigure() {
  return !!process.env.SMTP_HOST;
}

function construireRecap(rapport) {
  const T = rapport.totaux;
  const sujet = `[${rapport.entreprise}] Paie validée — ${rapport.libelle_mois}`;
  const lignes = rapport.secretaires.map((s) =>
    `  - ${s.prenom} ${s.nom} : ${formatHeures(s.minutes)} — salaire ${fmtF(s.salaire_brut)} — avances ${fmtF(s.avances_total)} — reste ${fmtF(s.net)}${s.solde_negatif ? ' (SOLDE NÉGATIF À EXAMINER)' : ''}`);
  const corps = [
    `Bonjour,`,
    ``,
    `La paie de ${rapport.libelle_mois} a été validée et clôturée${rapport.cloture ? ` par ${rapport.cloture.valide_par}` : ''}.`,
    ``,
    `Total des heures de toutes les secrétaires : ${formatHeures(T.minutes)}`,
    `Montant total des salaires calculés : ${fmtF(T.salaire_brut)}`,
    `Total des avances : ${fmtF(T.avances)}`,
    `Total des autres retenues : ${fmtF(T.retenues)}`,
    `Montant total restant à payer : ${fmtF(T.net)}`,
    ``,
    `Détail :`,
    ...lignes,
    ``,
    `Le rapport PDF complet est joint à ce message.`,
    ``,
    `— ${rapport.entreprise}, système de pointage`,
  ].join('\n');
  return { sujet, corps };
}

async function envoyerRecapMensuel(db, rapport, pdf) {
  const destinataire = getParam(db, 'email_admin');
  const { sujet, corps } = construireRecap(rapport);
  let statut = 'envoye';
  let erreur = null;
  if (!destinataire) {
    statut = 'non_envoye';
    erreur = 'Adresse e-mail de l’administrateur non renseignée (Paramètres).';
  } else if (!smtpConfigure()) {
    statut = 'non_envoye';
    erreur = 'Serveur SMTP non configuré (fichier .env).';
  } else {
    try {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === '1',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: destinataire,
        subject: sujet,
        text: corps,
        attachments: pdf ? [{ filename: `DCS_Salaires_${rapport.mois}.pdf`, content: pdf }] : [],
      });
    } catch (e) {
      statut = 'echec';
      erreur = e.message;
    }
  }
  db.prepare('INSERT INTO emails (mois, destinataire, sujet, corps, statut, erreur) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rapport.mois, destinataire || null, sujet, corps, statut, erreur);
  return { statut, erreur, destinataire };
}

module.exports = { envoyerRecapMensuel, construireRecap, smtpConfigure };
