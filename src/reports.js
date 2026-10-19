'use strict';
// Rapports mensuels PDF et Excel.
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { formatHeures } = require('./payroll');
const t = require('./time');

const fmtF = (n) => {
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${s} F`;
};
const heuresDec = (min) => Math.round((min / 60) * 100) / 100;
const STATUTS = { complet: 'Complet', incomplet: 'Incomplet (départ manquant)', en_cours: 'En cours', invalide: 'Invalide' };
const nomComplet = (s) => `${s.prenom} ${s.nom}`;
const tarifs = (s) => s.taux_appliques.map((x) => `${x} F`).join(' / ');
const dateFr = (d) => d.split('-').reverse().join('/');

function statutTexte(rapport) {
  if (rapport.statut === 'cloture') {
    return `Mois clôturé et validé le ${t.localDateTime(rapport.cloture.valide_le)} par ${rapport.cloture.valide_par}`;
  }
  return 'CALCUL PROVISOIRE — mois non clôturé';
}

function genererPdf(rapport) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 30;
    const bas = doc.page.height - 45;

    const entete = () => {
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#7a1f3d').text(rapport.entreprise, left, 30);
      doc.font('Helvetica').fontSize(11).fillColor('#222')
        .text(`Rapport mensuel des salaires — ${rapport.libelle_mois}`, left, 50);
      doc.fontSize(8.5).fillColor(rapport.statut === 'cloture' ? '#1b6e3a' : '#b35c00')
        .text(statutTexte(rapport), left, 66);
      doc.fillColor('#222');
      doc.y = 84;
    };

    const tableau = (cols, lignes, opts = {}) => {
      const h = 16;
      const dessinerLigne = (cells, style = {}) => {
        if (doc.y + h > bas) { doc.addPage(); entete(); if (style.pasEntete !== true && opts.entete) dessinerLigne(opts.entete, { gras: true, fond: '#efe3e7', pasEntete: true }); }
        const y = doc.y;
        if (style.fond) doc.rect(left, y, cols.reduce((a, c) => a + c.w, 0), h).fill(style.fond).fillColor('#222');
        let x = left;
        doc.font(style.gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(style.couleur || '#222');
        cells.forEach((c, i) => {
          doc.text(String(c ?? ''), x + 3, y + 4, { width: cols[i].w - 6, align: cols[i].align || 'left', lineBreak: false, ellipsis: true });
          x += cols[i].w;
        });
        doc.moveTo(left, y + h).lineTo(x, y + h).strokeColor('#ddd').lineWidth(0.5).stroke();
        doc.y = y + h;
      };
      // Pas d'en-tête de tableau orphelin en bas de page
      if (doc.y + 3 * h > bas) { doc.addPage(); entete(); }
      if (opts.entete) dessinerLigne(opts.entete, { gras: true, fond: '#efe3e7', pasEntete: true });
      for (const l of lignes) dessinerLigne(l.cells || l, l.style || {});
    };

    entete();

    // Récapitulatif
    doc.font('Helvetica-Bold').fontSize(11).text('Récapitulatif', left, doc.y);
    doc.moveDown(0.3);
    const colsRecap = [
      { w: 150 }, { w: 45, align: 'right' }, { w: 62, align: 'right' }, { w: 52, align: 'right' },
      { w: 48, align: 'right' }, { w: 60, align: 'right' }, { w: 85, align: 'right' },
      { w: 80, align: 'right' }, { w: 75, align: 'right' }, { w: 95, align: 'right' },
    ];
    tableau(colsRecap, [
      ...rapport.secretaires.map((s) => ({
        cells: [nomComplet(s), s.jours_travailles, formatHeures(s.minutes), formatHeures(s.minutes_hs), s.absences,
          tarifs(s), fmtF(s.salaire_brut), fmtF(s.avances_total), fmtF(s.retenues_total), fmtF(s.net)],
        style: s.solde_negatif ? { couleur: '#b00020' } : {},
      })),
      {
        cells: ['TOTAL GÉNÉRAL', rapport.totaux.jours_travailles, formatHeures(rapport.totaux.minutes),
          formatHeures(rapport.totaux.minutes_hs), rapport.totaux.absences, '—', fmtF(rapport.totaux.salaire_brut),
          fmtF(rapport.totaux.avances), fmtF(rapport.totaux.retenues), fmtF(rapport.totaux.net)],
        style: { gras: true, fond: '#f6f1e6' },
      },
    ], { entete: ['Secrétaire', 'Jours', 'Heures', 'H. supp.', 'Absences', 'Tarif/h', 'Salaire calculé', 'Avances', 'Retenues', 'Reste à payer'] });

    const negatifs = rapport.secretaires.filter((s) => s.solde_negatif);
    if (negatifs.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(8.5).fillColor('#b00020')
        .text(`Solde négatif à examiner : ${negatifs.map((s) => `${nomComplet(s)} (${fmtF(s.net)})`).join(', ')}. Aucun report automatique sur les mois suivants.`, left);
      doc.fillColor('#222');
    }
    if (rapport.totaux.incomplets) {
      doc.moveDown(0.3).font('Helvetica').fontSize(8.5).fillColor('#b35c00')
        .text(`${rapport.totaux.incomplets} pointage(s) incomplet(s) (arrivée sans départ) : non comptés dans les heures.`, left);
      doc.fillColor('#222');
    }
    doc.moveDown(0.3).font('Helvetica').fontSize(8).fillColor('#555')
      .text('Salaire calculé = heures validées × tarif horaire en vigueur. Reste à payer = salaire calculé - avances - retenues autorisées. Montants journaliers arrondis au franc ; le salaire du mois est calculé sur la durée exacte cumulée.', left);
    doc.fillColor('#222');

    // Détail par secrétaire
    const colsJour = [{ w: 70 }, { w: 300 }, { w: 65, align: 'right' }, { w: 55, align: 'right' },
      { w: 55, align: 'right' }, { w: 75, align: 'right' }, { w: 140 }];
    for (const s of rapport.secretaires) {
      doc.addPage();
      entete();
      doc.font('Helvetica-Bold').fontSize(11).text(`${nomComplet(s)} — détail des heures`, left, doc.y);
      doc.font('Helvetica').fontSize(8.5)
        .text(`Jours travaillés : ${s.jours_travailles}   Heures : ${formatHeures(s.minutes)}   H. supp. : ${formatHeures(s.minutes_hs)}   Absences : ${s.absences}   Tarif : ${tarifs(s)}`, left);
      doc.moveDown(0.3);
      tableau(colsJour, s.jours.map((j) => ({
        cells: [dateFr(j.date), j.presences.map((p) => `${p.arrivee} - ${p.depart || '—'}${p.corrige ? ' (corrigé)' : ''}`).join('   '),
          formatHeures(j.minutes), formatHeures(j.minutes_hs), `${j.taux} F`, fmtF(j.montant), STATUTS[j.statut] || j.statut],
        style: j.statut === 'incomplet' ? { couleur: '#b35c00' } : {},
      })).concat([{
        cells: ['Cumul', '', formatHeures(s.minutes), formatHeures(s.minutes_hs), '', fmtF(s.salaire_brut), ''],
        style: { gras: true, fond: '#f6f1e6' },
      }]), { entete: ['Date', 'Arrivée - Départ', 'Durée', 'H. supp.', 'Tarif', 'Montant', 'Statut'] });

      doc.moveDown(0.5);
      const ops = [
        ...s.avances.map((a) => ['Avance', dateFr(a.date_operation), a.motif || '', a.cree_par, fmtF(a.montant)]),
        ...s.retenues.map((r) => ['Retenue', dateFr(r.date_operation), r.motif || '', r.cree_par, fmtF(r.montant)]),
      ];
      if (ops.length) {
        tableau([{ w: 70 }, { w: 70 }, { w: 300 }, { w: 140 }, { w: 80, align: 'right' }], ops,
          { entete: ['Opération', 'Date', 'Motif', 'Enregistrée par', 'Montant'] });
        doc.moveDown(0.3);
      }
      doc.font('Helvetica-Bold').fontSize(9).fillColor(s.solde_negatif ? '#b00020' : '#222')
        .text(`Salaire calculé ${fmtF(s.salaire_brut)} - avances ${fmtF(s.avances_total)} - retenues ${fmtF(s.retenues_total)} = reste à payer ${fmtF(s.net)}${s.solde_negatif ? '  (SOLDE NÉGATIF À EXAMINER)' : ''}`, left);
      doc.fillColor('#222');
    }

    // Pied de page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // sinon PDFKit ajoute une page en écrivant sous la marge
      doc.font('Helvetica').fontSize(7).fillColor('#888')
        .text(`${rapport.entreprise} — ${rapport.libelle_mois} — généré le ${t.localDateTime(rapport.genere_le)} (heure de Bamako) — page ${i + 1}/${range.count}`,
          left, doc.page.height - 25, { width: doc.page.width - 60, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

async function genererExcel(rapport) {
  const wb = new ExcelJS.Workbook();
  wb.creator = rapport.entreprise;
  wb.created = new Date(rapport.genere_le);
  const titre = (ws, sousTitre, nbCols) => {
    ws.mergeCells(1, 1, 1, nbCols);
    ws.getCell(1, 1).value = rapport.entreprise;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF7A1F3D' } };
    ws.mergeCells(2, 1, 2, nbCols);
    ws.getCell(2, 1).value = `${sousTitre} — ${rapport.libelle_mois}`;
    ws.getCell(2, 1).font = { bold: true };
    ws.mergeCells(3, 1, 3, nbCols);
    ws.getCell(3, 1).value = statutTexte(rapport);
    ws.getCell(3, 1).font = { italic: true, color: { argb: rapport.statut === 'cloture' ? 'FF1B6E3A' : 'FFB35C00' } };
  };
  const enteteLigne = (row) => {
    row.font = { bold: true };
    row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE3E7' } }; c.border = { bottom: { style: 'thin' } }; });
  };
  const F = '#,##0" F"';

  // Récapitulatif
  const ws = wb.addWorksheet('Récapitulatif');
  titre(ws, 'Rapport mensuel des salaires', 11);
  ws.columns = [
    { width: 28 }, { width: 9 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 12 },
    { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 26 },
  ];
  ws.getRow(5).values = ['Secrétaire', 'Jours', 'Heures (déc.)', 'H. supp. (déc.)', 'Absences', 'Tarif/heure',
    'Salaire calculé', 'Avances', 'Retenues', 'Reste à payer', 'Observation'];
  enteteLigne(ws.getRow(5));
  let r = 6;
  for (const s of rapport.secretaires) {
    const row = ws.getRow(r++);
    row.values = [nomComplet(s), s.jours_travailles, heuresDec(s.minutes), heuresDec(s.minutes_hs), s.absences,
      s.taux_appliques.length === 1 ? s.taux_appliques[0] : tarifs(s), s.salaire_brut, s.avances_total,
      s.retenues_total, s.net,
      [s.solde_negatif ? 'Solde négatif à examiner' : '', s.incomplets.length ? `${s.incomplets.length} pointage(s) incomplet(s)` : '']
        .filter(Boolean).join(' ; ')];
    if (s.solde_negatif) row.getCell(10).font = { color: { argb: 'FFB00020' }, bold: true };
  }
  const tot = ws.getRow(r);
  tot.values = ['TOTAL GÉNÉRAL', rapport.totaux.jours_travailles, heuresDec(rapport.totaux.minutes),
    heuresDec(rapport.totaux.minutes_hs), rapport.totaux.absences, '—', rapport.totaux.salaire_brut,
    rapport.totaux.avances, rapport.totaux.retenues, rapport.totaux.net, ''];
  tot.font = { bold: true };
  tot.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F1E6' } }; c.border = { top: { style: 'thin' } }; });
  for (const col of [6, 7, 8, 9, 10]) ws.getColumn(col).numFmt = F;
  for (const col of [3, 4]) ws.getColumn(col).numFmt = '0.00';
  ws.getCell(r + 2, 1).value = 'Salaire calculé = heures validées × tarif horaire en vigueur. Reste à payer = salaire calculé − avances − retenues autorisées.';
  ws.getCell(r + 2, 1).font = { italic: true, size: 9 };

  // Détail journalier
  const wd = wb.addWorksheet('Heures par jour');
  titre(wd, 'Heures de chaque journée', 9);
  wd.columns = [{ width: 26 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 16 },
    { width: 14 }, { width: 10 }, { width: 13 }, { width: 30 }];
  wd.getRow(5).values = ['Secrétaire', 'Date', 'Arrivée', 'Départ', 'Heures jour (déc.)', 'H. supp. (déc.)', 'Tarif', 'Montant jour', 'Statut'];
  enteteLigne(wd.getRow(5));
  r = 6;
  for (const s of rapport.secretaires) {
    for (const j of s.jours) {
      j.presences.forEach((p, i) => {
        wd.getRow(r++).values = [nomComplet(s), dateFr(j.date), p.arrivee, p.depart || '—',
          i === 0 ? heuresDec(j.minutes) : null, i === 0 ? heuresDec(j.minutes_hs) : null,
          i === 0 ? j.taux : null, i === 0 ? j.montant : null,
          (STATUTS[p.statut] || p.statut) + (p.corrige ? ' (corrigé)' : '')];
      });
    }
    const c = wd.getRow(r++);
    c.values = [`Cumul ${nomComplet(s)}`, '', '', '', heuresDec(s.minutes), heuresDec(s.minutes_hs), '', s.salaire_brut, ''];
    c.font = { bold: true };
    r++;
  }
  wd.getColumn(7).numFmt = F;
  wd.getColumn(8).numFmt = F;
  for (const col of [5, 6]) wd.getColumn(col).numFmt = '0.00';

  // Avances et retenues
  const wa = wb.addWorksheet('Avances et retenues');
  titre(wa, 'Avances et retenues', 6);
  wa.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 36 }, { width: 22 }, { width: 14 }];
  wa.getRow(5).values = ['Secrétaire', 'Type', 'Date', 'Motif', 'Enregistrée par', 'Montant'];
  enteteLigne(wa.getRow(5));
  r = 6;
  for (const s of rapport.secretaires) {
    for (const a of s.avances) wa.getRow(r++).values = [nomComplet(s), 'Avance', dateFr(a.date_operation), a.motif || '', a.cree_par, a.montant];
    for (const x of s.retenues) wa.getRow(r++).values = [nomComplet(s), 'Retenue', dateFr(x.date_operation), x.motif || '', x.cree_par, x.montant];
  }
  wa.getColumn(6).numFmt = F;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { genererPdf, genererExcel, fmtF };
