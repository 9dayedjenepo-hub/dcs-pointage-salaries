'use strict';
// E-mails à l'administrateur : récapitulatif mensuel après validation de la paie
// et, si l'option est activée, notification à chaque arrivée et départ.
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

// Envoie un message à l'administrateur et le consigne dans la table emails (mois NULL = notification de pointage).
async function envoyerAdmin(db, { mois = null, sujet, corps, attachments = [] }) {
  const destinataire = getParam(db, 'email_admin');
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
        attachments,
      });
    } catch (e) {
      statut = 'echec';
      erreur = e.message;
    }
  }
  db.prepare('INSERT INTO emails (mois, destinataire, sujet, corps, statut, erreur) VALUES (?, ?, ?, ?, ?, ?)')
    .run(mois, destinataire || null, sujet, corps, statut, erreur);
  return { statut, erreur, destinataire };
}

function envoyerRecapMensuel(db, rapport, pdf) {
  const { sujet, corps } = construireRecap(rapport);
  return envoyerAdmin(db, {
    mois: rapport.mois, sujet, corps,
    attachments: pdf ? [{ filename: `DCS_Salaires_${rapport.mois}.pdf`, content: pdf }] : [],
  });
}

// Notification d'arrivée ou de départ (passage = résultat de enregistrerPassage).
function construireNotification(entreprise, p) {
  const [a, m, j] = p.date.split('-');
  const arrivee = p.type === 'arrivee';
  const sujet = `[${entreprise}] ${arrivee ? 'Arrivée' : 'Départ'} de ${p.secretaire} à ${p.heure}`;
  const corps = [
    `${p.secretaire} a pointé son ${arrivee ? 'arrivée' : 'départ'} le ${j}/${m}/${a} à ${p.heure} (heure de Bamako).`,
    ...(arrivee ? [] : [`Arrivée à ${p.arrivee} — durée de présence : ${formatHeures(p.minutes)}.`]),
    ...(p.source === 'telephone' ? ['Pointage effectué depuis son téléphone.'] : []),
    ``,
    `— ${entreprise}, système de pointage`,
  ].join('\n');
  return { sujet, corps };
}

// Ne lève jamais d'exception : le pointage est déjà enregistré quand elle est appelée.
async function notifierPassage(db, passage) {
  try {
    if (getParam(db, 'notif_pointage') !== '1') return null;
    return await envoyerAdmin(db, construireNotification(getParam(db, 'entreprise'), passage));
  } catch (e) {
    console.error('Notification de pointage impossible :', e.message);
    return null;
  }
}

module.exports = { envoyerRecapMensuel, construireRecap, construireNotification, notifierPassage, smtpConfigure };
