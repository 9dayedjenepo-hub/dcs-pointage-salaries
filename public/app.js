'use strict';
/* Djenepo Couture & Shopping — pointage QR et salaires (interface). */
(function () {
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toast = document.getElementById('toast');
  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const STATUT_POINTAGE = {
    complet: ['ok', 'Complet'], incomplet: ['attention', 'Départ manquant'], en_cours: ['info', 'En cours'],
    annule: ['neutre', 'Annulé'], invalide: ['erreur', 'Invalide'],
  };

  const state = { user: null, entreprise: 'Djenepo Couture & Shopping', mois: null, timers: [] };

  // ---------- Utilitaires ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const F = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F`;
  const H = (min) => { const h = Math.floor(min / 60); const m = min % 60; return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`; };
  const dateFr = (d) => (d ? d.split('-').reverse().join('/') : '');
  const nowBamako = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Bamako', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, heure: `${p.hour}:${p.minute}:${p.second}`, mois: `${p.year}-${p.month}` };
  };
  const moisLib = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MOIS[m - 1]} ${y}`; };
  const dtLocal = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Bamako', dateStyle: 'short', timeStyle: 'short' }) : '');
  const etat = (cls, txt) => `<span class="etat ${cls}">${esc(txt)}</span>`;

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-DCS': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* corps vide */ }
    if (res.status === 401 && state.user) { state.user = null; route(); }
    if (!res.ok) throw new Error(data?.erreur || `Erreur ${res.status}`);
    return data;
  }

  function toast(msg, erreur = false) {
    const el = document.createElement('div');
    el.className = `msg${erreur ? ' erreur' : ''}`;
    el.textContent = msg;
    $toast.appendChild(el);
    setTimeout(() => el.remove(), erreur ? 6000 : 3500);
  }

  // Modale de formulaire générique. champs: [{name,label,type,options,value,required,aide}]
  function formModal({ titre, intro = '', champs, bouton = 'Enregistrer', large = false, onSubmit }) {
    return new Promise((resolve) => {
      const html = champs.map((c) => {
        const id = `f_${c.name}`;
        const req = c.required ? 'required' : '';
        let input;
        if (c.type === 'select') {
          input = `<select id="${id}" name="${c.name}" ${req}>${c.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(c.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        } else if (c.type === 'textarea') {
          input = `<textarea id="${id}" name="${c.name}" ${req}>${esc(c.value ?? '')}</textarea>`;
        } else if (c.type === 'checkbox') {
          return `<div class="champ cases"><label><input type="checkbox" id="${id}" name="${c.name}" ${c.value ? 'checked' : ''}> ${esc(c.label)}</label>${c.aide ? `<div class="aide">${esc(c.aide)}</div>` : ''}</div>`;
        } else {
          input = `<input id="${id}" name="${c.name}" type="${c.type || 'text'}" value="${esc(c.value ?? '')}" ${req} ${c.attrs || ''}>`;
        }
        return `<div class="champ"><label for="${id}">${esc(c.label)}</label>${input}${c.aide ? `<div class="aide">${esc(c.aide)}</div>` : ''}</div>`;
      }).join('');
      $modal.innerHTML = `<div class="modal-fond"><form class="modal${large ? ' large' : ''}" novalidate>
        <h2>${esc(titre)}</h2>${intro}${html}<p class="erreur-form"></p>
        <div class="pied"><button type="button" class="sec" data-fermer>Annuler</button><button type="submit">${esc(bouton)}</button></div></form></div>`;
      const form = $modal.querySelector('form');
      const fermer = (v) => { $modal.innerHTML = ''; resolve(v); };
      form.querySelector('[data-fermer]').onclick = () => fermer(null);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const vals = {};
        for (const c of champs) {
          const el = form.elements[c.name];
          vals[c.name] = c.type === 'checkbox' ? el.checked : el.value.trim();
          if (c.required && !vals[c.name]) { form.querySelector('.erreur-form').textContent = `« ${c.label} » est obligatoire.`; el.focus(); return; }
        }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const r = onSubmit ? await onSubmit(vals) : vals;
          fermer(r ?? vals);
        } catch (err) {
          form.querySelector('.erreur-form').textContent = err.message;
          btn.disabled = false;
        }
      });
      const first = form.querySelector('input:not([type=checkbox]), select, textarea');
      if (first) first.focus();
    });
  }

  function infoModal(titre, contenu, large = true) {
    $modal.innerHTML = `<div class="modal-fond"><div class="modal${large ? ' large' : ''}"><h2>${esc(titre)}</h2>${contenu}
      <div class="pied"><button type="button" class="sec" data-fermer>Fermer</button></div></div></div>`;
    $modal.querySelector('[data-fermer]').onclick = () => { $modal.innerHTML = ''; };
  }

  function selecteurMois(ym, id = 'sel') {
    const [y, m] = ym.split('-').map(Number);
    const anneeCourante = Number(nowBamako().mois.slice(0, 4));
    const annees = [];
    for (let a = anneeCourante + 1; a >= anneeCourante - 5; a--) annees.push(a);
    return `<div class="ligne">
      <div class="champ"><label for="${id}-mois">Mois</label><select id="${id}-mois">${MOIS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="champ"><label for="${id}-annee">Année</label><select id="${id}-annee">${annees.map((a) => `<option ${a === y ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    </div>`;
  }
  function lireSelecteur(id = 'sel') {
    const m = document.getElementById(`${id}-mois`).value;
    const y = document.getElementById(`${id}-annee`).value;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  function brancherSelecteur(id, cb) {
    for (const s of ['mois', 'annee']) document.getElementById(`${id}-${s}`).addEventListener('change', () => cb(lireSelecteur(id)));
  }

  // ---------- Routage ----------
  const PAGES = [
    ['accueil', 'Tableau de bord', ['admin']],
    ['pointage', 'Pointage QR', ['admin', 'poste']],
    ['secretaires', 'Secrétaires', ['admin']],
    ['pointages', 'Pointages et corrections', ['admin']],
    ['salaires', 'Salaires et rémunérations', ['admin']],
    ['historique', 'Historique', ['admin']],
    ['parametres', 'Paramètres', ['admin']],
  ];

  function nettoyer() {
    state.timers.forEach(clearInterval);
    state.timers = [];
    if (state.scanner) { state.scanner.stop().catch(() => {}); state.scanner = null; }
    $modal.innerHTML = '';
  }

  async function route() {
    nettoyer();
    if (!state.user) return pageConnexion();
    const autorisees = PAGES.filter((p) => p[2].includes(state.user.role));
    let page = (location.hash || '').replace('#/', '');
    if (!autorisees.some((p) => p[0] === page)) page = autorisees[0][0];
    $app.innerHTML = `<div class="shell">
      <nav class="nav"><div class="marque">${esc(state.entreprise)}<small>Pointage & salaires</small></div>
        ${autorisees.map(([k, lib]) => `<a href="#/${k}" class="${k === page ? 'actif' : ''}">${esc(lib)}</a>`).join('')}
        <div class="bas"><span>${esc(state.user.nom_complet)}</span><button class="sec petit" id="btn-deco">Déconnexion</button></div>
      </nav><main class="contenu" id="page"></main></div>`;
    document.getElementById('btn-deco').onclick = async () => { await api('POST', '/api/deconnexion'); state.user = null; route(); };
    const el = document.getElementById('page');
    try {
      await ({ accueil: pageAccueil, pointage: pagePointage, secretaires: pageSecretaires, pointages: pagePointages, salaires: pageSalaires, historique: pageHistorique, parametres: pageParametres })[page](el);
    } catch (e) {
      el.innerHTML = `<div class="bandeau erreur">${esc(e.message)}</div>`;
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- Connexion / installation ----------
  async function pageConnexion() {
    const etatApp = await api('GET', '/api/etat');
    state.entreprise = etatApp.entreprise;
    if (etatApp.utilisateur) { state.user = etatApp.utilisateur; return route(); }
    const install = !etatApp.installe;
    $app.innerHTML = `<div class="connexion"><form class="carte" id="f-login">
      <h1>${esc(state.entreprise)}</h1>
      <p class="mut">${install ? 'Première utilisation : créez le compte administrateur (responsable).' : 'Pointage et salaires — connexion'}</p>
      ${install ? '<div class="champ"><label for="nc">Nom complet</label><input id="nc" required autocomplete="name"></div>' : ''}
      <div class="champ"><label for="nu">Identifiant</label><input id="nu" required autocomplete="username" autocapitalize="none"></div>
      <div class="champ"><label for="mp">Mot de passe</label><input id="mp" type="password" required autocomplete="${install ? 'new-password' : 'current-password'}">
      ${install ? '<div class="aide">8 caractères minimum.</div>' : ''}</div>
      <p class="erreur-form" id="err"></p>
      <button type="submit" style="width:100%;justify-content:center">${install ? 'Créer le compte et entrer' : 'Se connecter'}</button>
    </form></div>`;
    document.getElementById('nu').focus();
    document.getElementById('f-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { nom_utilisateur: document.getElementById('nu').value.trim(), mot_de_passe: document.getElementById('mp').value };
      try {
        let r;
        if (install) r = await api('POST', '/api/installation', { ...body, nom_complet: document.getElementById('nc').value.trim() });
        else r = await api('POST', '/api/connexion', body);
        state.user = r.utilisateur;
        const cible = state.user.role === 'poste' ? '#/pointage' : '#/accueil';
        if (location.hash === cible) route(); else location.hash = cible; // hashchange déclenche route()
      } catch (err) { document.getElementById('err').textContent = err.message; }
    });
  }

  // ---------- Tableau de bord ----------
  async function pageAccueil(el) {
    const [tb, auj] = await Promise.all([api('GET', '/api/tableau-de-bord'), api('GET', '/api/pointage/aujourdhui')]);
    const T = tb.mois_courant.totaux;
    el.innerHTML = `<div class="entete-page"><div><h1>Tableau de bord</h1><p>${esc(tb.mois_courant.libelle)} — calcul provisoire au tarif en vigueur</p></div>
      <a class="btn" href="#/salaires">Salaires et rémunérations</a></div>
      ${tb.a_valider.map((m) => `<div class="bandeau attention"><strong>Paie de ${esc(m.libelle)} calculée automatiquement, en attente de validation.</strong>
        ${H(m.totaux.minutes)} — ${F(m.totaux.salaire_brut)} calculés — ${F(m.totaux.net)} restant à payer${m.totaux.incomplets ? ` — ${m.totaux.incomplets} pointage(s) incomplet(s) à vérifier` : ''}.
        <a href="#/salaires" data-mois="${m.mois}">Vérifier et valider</a></div>`).join('')}
      ${!tb.email_admin || !tb.smtp ? `<div class="bandeau info">L’envoi du récapitulatif mensuel par e-mail n’est pas encore opérationnel : ${!tb.email_admin ? 'renseignez l’adresse de l’administrateur dans Paramètres' : ''}${!tb.email_admin && !tb.smtp ? ' et ' : ''}${!tb.smtp ? 'configurez le serveur SMTP (fichier .env)' : ''}.</div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="lib">Heures validées du mois</div><div class="val">${H(T.minutes)}</div></div>
        <div class="kpi accent"><div class="lib">Salaires calculés</div><div class="val">${F(T.salaire_brut)}</div></div>
        <div class="kpi"><div class="lib">Avances du mois</div><div class="val">${F(T.avances)}</div></div>
        <div class="kpi"><div class="lib">Reste à payer (provisoire)</div><div class="val">${F(T.net)}</div></div>
        <div class="kpi"><div class="lib">Pointages incomplets</div><div class="val">${T.incomplets}</div></div>
      </div>
      <div class="carte"><h2>Présences du jour — ${dateFr(auj.date)}</h2>${tableauPresences(auj.liste)}</div>`;
    el.querySelectorAll('[data-mois]').forEach((a) => a.addEventListener('click', () => { state.mois = a.dataset.mois; }));
  }

  function tableauPresences(liste) {
    if (!liste.length) return '<p class="vide">Aucune secrétaire active. Ajoutez-les dans « Secrétaires ».</p>';
    const lib = { present: ['ok', 'Présente'], parti: ['info', 'Partie'], absent: ['neutre', 'Pas encore pointé'] };
    return `<div class="table-wrap"><table><thead><tr><th>Secrétaire</th><th>État</th><th>Arrivées / départs</th></tr></thead><tbody>
      ${liste.map((s) => `<tr><td>${esc(s.prenom)} ${esc(s.nom)}</td><td>${etat(...lib[s.statut])}</td>
      <td>${s.presences.map((p) => `${p.arrivee} → ${p.depart || '…'}`).join(' &nbsp; ') || '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Pointage QR ----------
  async function pagePointage(el) {
    el.innerHTML = `<div class="entete-page"><div><h1>Pointage QR code</h1><p>Les secrétaires scannent ce QR code avec leur téléphone : 1<sup>er</sup> scan = arrivée, 2<sup>e</sup> scan = départ. L’heure enregistrée est celle du serveur (Bamako).</p></div></div>
      <div class="poste">
        <div class="carte qr-boutique">
          <div class="consigne">Scannez ce QR code avec votre téléphone</div>
          <div class="horloge" id="horloge">--:--:--</div>
          <img id="qr-img" alt="QR code de pointage de la boutique">
          <div class="compte" id="qr-info"></div>
          <div id="qr-alerte"></div>
          <details class="secours"><summary>Secours : badge personnel ou lecteur USB</summary>
            <div id="lecteur" style="margin-top:.8rem"></div>
            <div class="actions" style="justify-content:center;margin-top:.8rem">
              <button id="btn-camera" class="sec">Scanner un badge avec la caméra</button>
            </div>
            <form id="f-scan" style="margin-top:1rem;text-align:left">
              <label for="code">Lecteur de QR code USB / saisie du code du badge</label>
              <div class="ligne"><div class="champ"><input id="code" autocomplete="off" placeholder="Scannez le badge…"></div><button type="submit">Valider</button></div>
            </form>
            <div class="resultat-scan" id="resultat"><span class="mut">En attente d’un badge…</span></div>
          </details>
        </div>
        <div class="carte"><h2>Présences du jour</h2><div id="presences"></div></div>
      </div>`;
    const $res = document.getElementById('resultat');
    const $code = document.getElementById('code');
    const tic = () => { document.getElementById('horloge').textContent = nowBamako().heure; };
    tic();
    state.timers.push(setInterval(tic, 1000));
    const rafraichir = async () => {
      try { document.getElementById('presences').innerHTML = tableauPresences((await api('GET', '/api/pointage/aujourdhui')).liste); } catch { /* ignoré */ }
    };
    rafraichir();
    state.timers.push(setInterval(rafraichir, 10000));

    // QR de la boutique : renouvelé toutes les 30 s en mode dynamique.
    let finQr = 0;
    const majQr = async () => {
      try {
        const q = await api('GET', '/api/qr-boutique');
        document.getElementById('qr-img').src = q.qr;
        document.getElementById('qr-alerte').innerHTML = q.adresse_locale
          ? '<div class="bandeau erreur" style="margin-top:.8rem;text-align:left">Ce QR contient l’adresse « localhost », que les téléphones ne peuvent pas ouvrir. Renseignez l’adresse réseau du serveur dans <strong>Paramètres › Pointage par téléphone</strong>.</div>' : '';
        if (q.mode === 'dynamique') {
          finQr = Date.now() + q.renouvele_dans_s * 1000;
          state.timers.push(setTimeout(majQr, q.renouvele_dans_s * 1000 + 300));
        } else {
          finQr = 0;
          document.getElementById('qr-info').textContent = 'QR fixe (mode imprimé).';
        }
      } catch (e) {
        document.getElementById('qr-info').textContent = `QR indisponible : ${e.message}`;
        state.timers.push(setTimeout(majQr, 5000));
      }
    };
    majQr();
    state.timers.push(setInterval(() => {
      if (finQr) document.getElementById('qr-info').textContent = `Nouveau code dans ${Math.max(0, Math.ceil((finQr - Date.now()) / 1000))} s — une photo de ce QR ne permet pas de pointer plus tard.`;
    }, 1000));

    let occupe = false;
    let dernierCode = '';
    let dernierInstant = 0;
    async function envoyer(code) {
      code = code.trim();
      if (!code || occupe) return;
      if (code === dernierCode && Date.now() - dernierInstant < 5000) return; // évite les lectures en rafale de la caméra
      dernierCode = code; dernierInstant = Date.now();
      occupe = true;
      try {
        const r = await api('POST', '/api/pointage/scan', { code });
        $res.className = `resultat-scan ${r.type}`;
        $res.innerHTML = `<div class="gros">${r.type === 'arrivee' ? 'Arrivée' : 'Départ'} enregistré${r.type === 'arrivee' ? 'e' : ''} — ${esc(r.heure)}</div>
          <div style="font-size:1.2rem;margin-top:.3rem">${esc(r.secretaire)}</div>
          ${r.type === 'depart' ? `<div>Présence : ${H(r.minutes)} (arrivée ${esc(r.arrivee)})</div>` : ''}
          ${r.incomplet_precedent ? `<div style="margin-top:.4rem;color:#a35400">Attention : départ non pointé le ${dateFr(r.incomplet_precedent)} — signalé à l’administrateur.</div>` : ''}`;
        if (navigator.vibrate) navigator.vibrate(120);
        rafraichir();
      } catch (e) {
        $res.className = 'resultat-scan erreur';
        $res.innerHTML = `<div class="gros">Pointage refusé</div><div>${esc(e.message)}</div>`;
      } finally {
        occupe = false;
        $code.value = '';
        $code.focus();
      }
    }
    document.getElementById('f-scan').addEventListener('submit', (e) => { e.preventDefault(); envoyer($code.value); });
    $code.focus();

    document.getElementById('btn-camera').onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (state.scanner) {
        await state.scanner.stop().catch(() => {});
        state.scanner = null;
        btn.textContent = 'Scanner un badge avec la caméra';
        return;
      }
      btn.disabled = true;
      try {
        await chargerLibQr();
        state.scanner = new window.Html5Qrcode('lecteur');
        await state.scanner.start({ facingMode: 'environment' }, { fps: 8, qrbox: 240 }, (txt) => envoyer(txt), () => {});
        btn.textContent = 'Arrêter la caméra';
      } catch (e) {
        state.scanner = null;
        toast(`Caméra indisponible : ${e.message || e}. Utilisez un lecteur USB ou la saisie.`, true);
      } finally { btn.disabled = false; }
    };
  }

  function chargerLibQr() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      s.onload = ok;
      s.onerror = () => ko(new Error('bibliothèque de lecture QR non chargée (connexion Internet ?)'));
      document.head.appendChild(s);
    });
  }

  // ---------- Secrétaires ----------
  async function pageSecretaires(el) {
    const [liste, appareils] = await Promise.all([api('GET', '/api/secretaires'), api('GET', '/api/appareils')]);
    const tel = (id) => appareils.find((a) => a.secretaire_id === id);
    const archivees = liste.filter((s) => s.archive);
    el.innerHTML = `<div class="entete-page"><div><h1>Secrétaires</h1><p>Chaque secrétaire pointe avec son téléphone, après l’avoir activé une seule fois. Le badge QR reste disponible en secours.</p>
      <p class="mut"><strong>Désactiver</strong> (Modifier › décocher « Active ») : elle ne peut plus pointer, tout reste visible. <strong>Supprimer</strong> : suppression définitive si aucune donnée n’existe, sinon archivage qui conserve ses heures, salaires, avances et rapports.</p></div>
      <button id="btn-ajout">+ Ajouter une secrétaire</button></div>
      <div class="carte table-wrap"><table><thead><tr><th>Nom et prénom</th><th>N° de téléphone</th><th>Embauche</th><th>État</th><th>Téléphone de pointage</th><th>Actions</th></tr></thead><tbody>
      ${liste.filter((s) => !s.archive).map((s) => {
        const a = tel(s.id);
        return `<tr><td>${esc(s.prenom)} ${esc(s.nom)}</td><td>${esc(s.telephone || '')}</td><td>${dateFr(s.date_embauche)}</td>
        <td>${s.actif ? etat('ok', 'Active') : etat('neutre', 'Inactive')}</td>
        <td>${a ? `${etat('ok', 'Activé')}<br><small class="mut">le ${esc(dtLocal(a.cree_le))}${a.dernier_usage ? ` · dernier pointage ${esc(dtLocal(a.dernier_usage))}` : ''}</small>` : etat('attention', 'Non activé')}</td>
        <td class="actions">${s.actif ? `<button class="petit" data-act="activer" data-id="${s.id}">${a ? 'Changer de téléphone' : 'Activer son téléphone'}</button>` : ''}
        ${a ? `<button class="danger petit" data-act="revoquer" data-id="${s.id}">Désactiver le téléphone</button>` : ''}
        <button class="sec petit" data-act="modif" data-id="${s.id}">Modifier</button>
        <button class="sec petit" data-act="badge" data-id="${s.id}">Badge (secours)</button>
        <button class="sec petit" data-act="nouveau" data-id="${s.id}">Nouveau badge</button>
        <button class="danger petit" data-act="supprimer" data-id="${s.id}">Supprimer</button></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="vide">Aucune secrétaire enregistrée.</td></tr>'}
      </tbody></table></div>
      ${archivees.length ? `<details class="carte"><summary><strong>Secrétaires archivées (${archivees.length})</strong> — historique conservé, pointage impossible</summary>
        <div class="table-wrap" style="margin-top:.6rem"><table><thead><tr><th>Nom et prénom</th><th>Archivée le</th><th>Par</th><th></th></tr></thead><tbody>
        ${archivees.map((s) => `<tr><td>${esc(s.prenom)} ${esc(s.nom)}</td><td>${esc(dtLocal(s.archive_le))}</td><td>${esc(s.archive_par_nom || '')}</td>
          <td><button class="sec petit" data-act="restaurer" data-id="${s.id}">Restaurer</button></td></tr>`).join('')}
        </tbody></table></div></details>` : ''}
      <div class="badge-impr" id="badge-impr"></div>`;
    const formSec = (s = {}) => [
      { name: 'prenom', label: 'Prénom', required: true, value: s.prenom },
      { name: 'nom', label: 'Nom', required: true, value: s.nom },
      { name: 'telephone', label: 'Téléphone', value: s.telephone },
      { name: 'date_embauche', label: 'Date d’embauche', type: 'date', value: s.date_embauche, aide: 'Les absences ne sont comptées qu’à partir de cette date.' },
    ];
    document.getElementById('btn-ajout').onclick = async () => {
      const r = await formModal({ titre: 'Nouvelle secrétaire', champs: formSec(), onSubmit: (v) => api('POST', '/api/secretaires', v) });
      if (r) { toast('Secrétaire ajoutée.'); route(); }
    };
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const s = liste.find((x) => x.id === Number(b.dataset.id));
      if (b.dataset.act === 'activer') {
        try {
          const r = await api('POST', `/api/secretaires/${s.id}/activation`);
          infoModal(`Activer le téléphone de ${s.prenom} ${s.nom}`, `<div style="text-align:center">
            ${r.adresse_locale ? '<div class="bandeau erreur" style="text-align:left">Ce QR contient l’adresse « localhost », que le téléphone ne pourra pas ouvrir. Renseignez d’abord l’adresse réseau du serveur dans <strong>Paramètres › Pointage par téléphone</strong>, puis recommencez.</div>' : ''}
            <img src="${r.qr}" alt="QR d’activation" style="width:280px;max-width:100%;image-rendering:pixelated">
            <ol style="text-align:left;max-width:440px;margin:.6rem auto">
              <li>${esc(s.prenom)} ouvre l’appareil photo de <strong>son</strong> téléphone et scanne ce QR code.</li>
              <li>Elle touche le lien qui apparaît : la page confirme « Téléphone activé ».</li>
              <li>Ensuite, elle pointe en scannant le QR de la boutique à chaque arrivée et à chaque départ.</li>
            </ol>
            <p class="mut">QR à usage unique, valable jusqu’au ${esc(dtLocal(r.expire_le))}. Ne le montrez qu’à ${esc(s.prenom)}. ${tel(s.id) ? 'Son ancien téléphone sera désactivé.' : ''}</p></div>`, false);
          $modal.querySelector('[data-fermer]').addEventListener('click', () => route());
        } catch (e) { toast(e.message, true); }
        return;
      }
      if (b.dataset.act === 'supprimer') {
        let info;
        try { info = await api('GET', `/api/secretaires/${s.id}/suppression`); } catch (e) { toast(e.message, true); return; }
        const nom = `${s.prenom} ${s.nom}`;
        if (!info.definitive_possible) {
          const details = [
            info.pointages ? `${info.pointages} pointage(s)` : '',
            info.avances ? `${info.avances} avance(s)` : '',
            info.retenues ? `${info.retenues} retenue(s)` : '',
            info.mois_clotures.length ? `${info.mois_clotures.length} mois clôturé(s) (${info.mois_clotures.map(moisLib).join(', ')})` : '',
          ].filter(Boolean).join(', ');
          const r = await formModal({
            titre: `Supprimer ${nom}`, bouton: 'Archiver la secrétaire',
            intro: `<div class="bandeau attention"><strong>${esc(nom)} possède des données : ${esc(details)}.</strong><br>
              Pour préserver les salaires et les anciens rapports, elle sera <strong>archivée</strong> au lieu d’être effacée :</div>
              <ul><li>elle disparaît de la liste et ne peut plus pointer (téléphone et badge désactivés) ;</li>
              <li>ses heures, salaires, avances et rapports restent intacts ;</li>
              <li>vous pourrez la restaurer à tout moment.</li></ul>`,
            champs: [{ name: 'confirmation', label: 'Pour confirmer, saisissez SUPPRIMER', required: true }],
            onSubmit: (v) => api('DELETE', `/api/secretaires/${s.id}`, { confirmation: v.confirmation }),
          });
          if (r) { toast(`${nom} a été archivée. Son historique est conservé.`); route(); }
          return;
        }
        // Aucune donnée liée : suppression définitive, avec deux confirmations.
        const ok1 = await formModal({
          titre: `Supprimer définitivement ${nom} ?`, bouton: 'Continuer',
          intro: `<div class="bandeau erreur"><strong>Suppression définitive.</strong> ${esc(nom)} n’a aucun pointage, aucune avance et n’apparaît dans aucun mois clôturé.
            Sa fiche, son badge et l’activation de son téléphone seront effacés. <strong>Cette opération est irréversible.</strong></div>`,
          champs: [],
        });
        if (!ok1) return;
        const r = await formModal({
          titre: 'Deuxième confirmation', bouton: 'Supprimer définitivement',
          intro: `<p>Confirmez la suppression définitive de <strong>${esc(nom)}</strong>.</p>`,
          champs: [{ name: 'confirmation', label: 'Saisissez SUPPRIMER (en majuscules)', required: true }],
          onSubmit: (v) => api('DELETE', `/api/secretaires/${s.id}`, { confirmation: v.confirmation }),
        });
        if (r) { toast(`${nom} a été supprimée définitivement.`); route(); }
        return;
      }
      if (b.dataset.act === 'restaurer') {
        const r = await formModal({
          titre: `Restaurer ${s.prenom} ${s.nom}`, bouton: 'Restaurer',
          intro: '<p>Elle réapparaîtra dans la liste, <strong>inactive</strong> : cochez « Active » (Modifier) puis réactivez son téléphone pour qu’elle puisse de nouveau pointer.</p>',
          champs: [], onSubmit: () => api('POST', `/api/secretaires/${s.id}/restaurer`),
        });
        if (r) { toast('Secrétaire restaurée.'); route(); }
        return;
      }
      if (b.dataset.act === 'revoquer') {
        const r = await formModal({
          titre: 'Désactiver le téléphone', bouton: 'Désactiver',
          intro: `<p>Le téléphone de <strong>${esc(s.prenom)} ${esc(s.nom)}</strong> ne pourra plus pointer (téléphone perdu, changé ou prêté). Les pointages déjà enregistrés sont conservés. Vous pourrez activer un nouveau téléphone.</p>`,
          champs: [], onSubmit: () => api('POST', `/api/appareils/${tel(s.id).id}/revoquer`),
        });
        if (r) { toast('Téléphone désactivé.'); route(); }
        return;
      }
      if (b.dataset.act === 'modif') {
        const r = await formModal({
          titre: `Modifier ${s.prenom} ${s.nom}`,
          champs: [...formSec(s), { name: 'actif', label: 'Active (peut pointer)', type: 'checkbox', value: !!s.actif }],
          onSubmit: (v) => api('PUT', `/api/secretaires/${s.id}`, v),
        });
        if (r) { toast('Modifications enregistrées.'); route(); }
      } else if (b.dataset.act === 'nouveau') {
        const r = await formModal({
          titre: 'Remplacer le badge QR',
          intro: `<p>L’ancien badge de <strong>${esc(s.prenom)} ${esc(s.nom)}</strong> ne fonctionnera plus (badge perdu ou volé). Les pointages déjà enregistrés sont conservés.</p>`,
          champs: [], bouton: 'Générer un nouveau badge',
          onSubmit: () => api('POST', `/api/secretaires/${s.id}/nouveau-badge`),
        });
        if (r) { toast('Nouveau badge généré : imprimez-le.'); afficherBadge(s); }
      } else afficherBadge(s);
    }));
    function afficherBadge(s) {
      const src = `/api/secretaires/${s.id}/qr.png?t=${Date.now()}`;
      document.getElementById('badge-impr').innerHTML = `<strong style="color:#7a1f3d">${esc(state.entreprise)}</strong><br><img src="${src}" alt=""><br><strong>${esc(s.prenom)} ${esc(s.nom)}</strong><br><small>Badge de pointage personnel</small>`;
      infoModal(`Badge QR — ${s.prenom} ${s.nom}`, `<div style="text-align:center"><img src="${src}" alt="QR code de ${esc(s.prenom)}" style="width:260px;max-width:100%"><p class="mut">Badge strictement personnel. Imprimez-le et remettez-le à la secrétaire.</p><button id="btn-impr">Imprimer le badge</button></div>`, false);
      document.getElementById('btn-impr').onclick = () => window.print();
    }
  }

  // ---------- Pointages et corrections ----------
  async function pagePointages(el) {
    const mois = state.mois || nowBamako().mois;
    const secs = await api('GET', '/api/secretaires');
    el.innerHTML = `<div class="entete-page"><div><h1>Pointages et corrections</h1><p>Toute correction exige une justification et est conservée dans l’historique.</p></div>
      <button id="btn-ajout">+ Ajouter un pointage</button></div>
      <div class="carte"><div class="ligne">${selecteurMois(mois, 'pm')}
        <div class="champ"><label for="fsec">Secrétaire</label><select id="fsec"><option value="">Toutes</option>${secs.map((s) => `<option value="${s.id}">${esc(s.prenom)} ${esc(s.nom)}</option>`).join('')}</select></div>
        <div class="champ"><label for="fstat">Statut</label><select id="fstat"><option value="">Tous</option><option value="incomplet">Départ manquant</option><option value="corrige">Corrigés</option><option value="annule">Annulés</option></select></div>
      </div></div><div id="zone"></div>`;
    const charger = async () => {
      const m = lireSelecteur('pm');
      state.mois = m;
      const sid = document.getElementById('fsec').value;
      const st = document.getElementById('fstat').value;
      const r = await api('GET', `/api/pointages?mois=${m}${sid ? `&secretaire_id=${sid}` : ''}`);
      let pts = r.pointages;
      if (st === 'corrige') pts = pts.filter((p) => p.corrige);
      else if (st) pts = pts.filter((p) => p.statut === st);
      const nbInc = r.pointages.filter((p) => p.statut === 'incomplet').length;
      document.getElementById('zone').innerHTML = `
        ${r.cloture ? `<div class="bandeau ok">${esc(moisLib(m))} est clôturé : les pointages ne peuvent plus être modifiés.</div>` : ''}
        ${nbInc ? `<div class="bandeau attention">${nbInc} arrivée(s) sans départ enregistré : ces présences ne sont pas comptées tant qu’elles ne sont pas corrigées.</div>` : ''}
        <div class="carte table-wrap"><table><thead><tr><th>Date</th><th>Secrétaire</th><th>Arrivée</th><th>Départ</th><th class="n">Durée</th><th>Statut</th><th>Actions</th></tr></thead><tbody>
        ${pts.map((p) => `<tr class="${p.statut === 'annule' ? 'annule' : ''}"><td>${dateFr(p.date)} <span class="mut">${JOURS[new Date(p.date + 'T12:00:00Z').getUTCDay()].slice(0, 3)}.</span></td>
          <td>${esc(p.secretaire)}</td><td>${p.arrivee}</td><td>${p.depart ? p.depart + (p.depart_date !== p.date ? ' (+1 j)' : '') : '—'}</td>
          <td class="n">${p.minutes != null ? H(p.minutes) : '—'}</td>
          <td>${etat(...STATUT_POINTAGE[p.statut])} ${p.corrige ? etat('info', 'Corrigé') : ''}
            <br><small class="mut">${{ telephone: 'Téléphone', qr: 'Badge', correction: 'Saisie manuelle' }[p.source]}${p.distance_arrivee_m != null ? ` · ${p.distance_arrivee_m} m` : ''}${p.distance_depart_m != null ? ` / ${p.distance_depart_m} m` : ''}</small></td>
          <td class="actions">${!r.cloture && p.statut !== 'annule' ? `<button class="sec petit" data-act="corriger" data-id="${p.id}">Corriger</button><button class="danger petit" data-act="annuler" data-id="${p.id}">Annuler</button>` : ''}
          ${p.corrige ? `<button class="sec petit" data-act="hist" data-id="${p.id}">Historique</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="vide">Aucun pointage pour cette sélection.</td></tr>'}
        </tbody></table></div>`;
      document.querySelectorAll('#zone [data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act, pts.find((p) => p.id === Number(b.dataset.id)))));
    };
    const justif = { name: 'justification', label: 'Justification (obligatoire)', type: 'textarea', required: true, aide: 'Ex. : oubli de pointage au départ, confirmé par la responsable.' };
    async function action(act, p) {
      if (act === 'corriger') {
        const r = await formModal({
          titre: `Corriger le pointage de ${p.secretaire}`,
          intro: '<p class="mut">Correction exceptionnelle : l’ancienne valeur, la nouvelle, votre nom et la justification sont conservés.</p>',
          champs: [
            { name: 'date', label: 'Date', type: 'date', value: p.date, required: true },
            { name: 'arrivee', label: 'Heure d’arrivée', type: 'time', value: p.arrivee, required: true },
            { name: 'depart', label: 'Heure de départ', type: 'time', value: p.depart || '', aide: 'Laisser vide si le départ est inconnu (la présence restera non comptée).' },
            justif,
          ],
          onSubmit: (v) => api('PUT', `/api/pointages/${p.id}`, v),
        });
        if (r) { toast('Pointage corrigé.'); charger(); }
      } else if (act === 'annuler') {
        const r = await formModal({
          titre: 'Annuler ce pointage', bouton: 'Annuler le pointage',
          intro: `<p>${esc(p.secretaire)} — ${dateFr(p.date)}, ${p.arrivee} → ${p.depart || '—'}. Le pointage n’est pas supprimé : il est marqué annulé et n’est plus compté.</p>`,
          champs: [justif],
          onSubmit: (v) => api('POST', `/api/pointages/${p.id}/annuler`, v),
        });
        if (r) { toast('Pointage annulé.'); charger(); }
      } else if (act === 'hist') {
        const h = await api('GET', `/api/corrections?pointage_id=${p.id}`);
        infoModal('Historique des corrections', tableauCorrections(h));
      }
    }
    document.getElementById('btn-ajout').onclick = async () => {
      const r = await formModal({
        titre: 'Ajouter un pointage manuellement',
        intro: '<p class="mut">À utiliser exceptionnellement (badge oublié, panne). L’opération est tracée.</p>',
        champs: [
          { name: 'secretaire_id', label: 'Secrétaire', type: 'select', required: true, options: [{ value: '', label: '— Choisir —' }, ...secs.filter((s) => s.actif).map((s) => ({ value: s.id, label: `${s.prenom} ${s.nom}` }))] },
          { name: 'date', label: 'Date', type: 'date', required: true, value: nowBamako().date },
          { name: 'arrivee', label: 'Heure d’arrivée', type: 'time', required: true },
          { name: 'depart', label: 'Heure de départ', type: 'time' },
          justif,
        ],
        onSubmit: (v) => api('POST', '/api/pointages', v),
      });
      if (r) { toast('Pointage ajouté.'); charger(); }
    };
    brancherSelecteur('pm', charger);
    document.getElementById('fsec').onchange = charger;
    document.getElementById('fstat').onchange = charger;
    await charger();
  }

  function tableauCorrections(h) {
    const v = (x) => (x ? `${dateFr(x.date)} ${x.arrivee} → ${x.depart || '—'}${x.annule ? ' (annulé)' : ''}` : '—');
    const lib = { creation: 'Ajout', modification: 'Modification', annulation: 'Annulation' };
    return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Secrétaire</th><th>Action</th><th>Avant</th><th>Après</th><th>Justification</th><th>Par</th></tr></thead><tbody>
      ${h.map((c) => `<tr><td>${esc(c.cree_le_local)}</td><td>${esc(c.secretaire)}</td><td>${lib[c.action]}</td><td>${esc(v(c.ancienne_valeur))}</td><td>${esc(v(c.nouvelle_valeur))}</td><td>${esc(c.justification)}</td><td>${esc(c.admin)}</td></tr>`).join('') || '<tr><td colspan="7" class="vide">Aucune correction.</td></tr>'}
      </tbody></table></div>`;
  }

  // ---------- Salaires et rémunérations ----------
  async function pageSalaires(el) {
    const mois = state.mois || nowBamako().mois;
    el.innerHTML = `<div class="entete-page"><div><h1>Salaires et rémunérations</h1><p>Salaire = heures travaillées et validées × tarif horaire. Reste à payer = salaire calculé − avances − autres retenues autorisées.</p><p class="mut">Arrondi : calcul exact à la minute, puis arrondi au franc le plus proche une seule fois, sur le total du mois (ex. 3 h 30 × 125 F = 437,5 F → 438 F).</p></div></div>
      <div class="carte">${selecteurMois(mois, 'sm')}</div><div id="zone"></div>`;
    brancherSelecteur('sm', (m) => { state.mois = m; charger(); });
    const secs = await api('GET', '/api/secretaires');

    async function charger() {
      const m = lireSelecteur('sm');
      const zone = document.getElementById('zone');
      zone.innerHTML = '<p class="chargement">Calcul en cours…</p>';
      const [p, avances, retenues] = await Promise.all([
        api('GET', `/api/paie?mois=${m}`), api('GET', `/api/avances?mois=${m}`), api('GET', `/api/retenues?mois=${m}`),
      ]);
      const T = p.totaux;
      const clos = p.statut === 'cloture';
      const incomplets = p.secretaires.flatMap((s) => s.incomplets.map((i) => ({ ...i, nom: `${s.prenom} ${s.nom}` })));
      const anomalies = p.secretaires.flatMap((s) => s.anomalies.map((a) => ({ ...a, nom: `${s.prenom} ${s.nom}` })));
      const negatifs = p.secretaires.filter((s) => s.solde_negatif);
      const tx = p.taux_en_vigueur;

      zone.innerHTML = `
        ${clos ? `<div class="bandeau ok"><strong>Mois clôturé et validé</strong> le ${esc(dtLocal(p.cloture.valide_le))} par ${esc(p.cloture.valide_par)}. Les montants sont figés et ne seront plus recalculés.${p.cloture.commentaire ? `<br>Commentaire : ${esc(p.cloture.commentaire)}` : ''}<div style="margin-top:.5rem"><button class="danger petit" id="btn-rouvrir">Rouvrir pour une correction exceptionnelle</button></div></div>`
          : `<div class="bandeau info"><strong>Calcul provisoire</strong> — ${p.mois_termine ? 'mois terminé, en attente de votre validation.' : 'mois en cours, les chiffres évoluent avec les pointages.'} Tarif en vigueur : <strong>${F(tx.taux)}/heure</strong>${tx.hs_seuil_minutes != null ? `, heures supplémentaires au-delà de ${H(tx.hs_seuil_minutes)}/jour majorées de ${tx.hs_majoration_pct} %` : ', heures supplémentaires non configurées'}.</div>`}
        ${incomplets.length ? `<div class="bandeau attention"><strong>${incomplets.length} arrivée(s) sans départ enregistré</strong> — non comptées dans les heures :<ul>${incomplets.map((i) => `<li>${esc(i.nom)} — ${dateFr(i.date)}, arrivée ${i.arrivee}</li>`).join('')}</ul>${!clos ? '<a href="#/pointages">Corriger dans « Pointages et corrections »</a>' : ''}</div>` : ''}
        ${anomalies.length ? `<div class="bandeau attention"><strong>Anomalies à vérifier :</strong><ul>${anomalies.map((a) => `<li>${esc(a.nom)} — ${dateFr(a.date)} : ${esc(a.message)}</li>`).join('')}</ul></div>` : ''}
        ${negatifs.length ? `<div class="bandeau erreur"><strong>Solde négatif à examiner :</strong> ${negatifs.map((s) => `${esc(s.prenom)} ${esc(s.nom)} (${F(s.net)})`).join(', ')}. Les avances dépassent le salaire calculé ; rien n’est reporté automatiquement sur les mois suivants.</div>` : ''}
        <div class="kpis">
          <div class="kpi"><div class="lib">Total des heures</div><div class="val">${H(T.minutes)}</div></div>
          <div class="kpi accent"><div class="lib">Total des salaires calculés</div><div class="val">${F(T.salaire_brut)}</div></div>
          <div class="kpi"><div class="lib">Total des avances</div><div class="val">${F(T.avances)}</div></div>
          <div class="kpi"><div class="lib">Autres retenues</div><div class="val">${F(T.retenues)}</div></div>
          <div class="kpi accent"><div class="lib">Total restant à payer</div><div class="val ${T.net < 0 ? 'negatif' : ''}">${F(T.net)}</div></div>
        </div>
        <div class="carte">
          <div class="entete-page" style="margin-bottom:.5rem"><h2 style="margin:0">Détail par secrétaire — ${esc(p.libelle_mois)}</h2>
            <div class="actions">
              <a class="btn sec" href="/api/paie/${m}/rapport.pdf" target="_blank" rel="noopener">Imprimer (PDF)</a>
              <a class="btn sec" href="/api/paie/${m}/rapport.pdf?telecharger=1">Télécharger PDF</a>
              <a class="btn sec" href="/api/paie/${m}/rapport.xlsx">Télécharger Excel</a>
              ${!clos && p.mois_termine ? '<button class="vert" id="btn-cloturer">Valider et clôturer le mois</button>' : ''}
              ${clos ? '<button class="sec" id="btn-email">Renvoyer le récapitulatif e-mail</button>' : ''}
            </div></div>
          <div class="table-wrap"><table><thead><tr>
            <th>Nom et prénom</th><th class="n">Jours travaillés</th><th class="n">Heures</th><th class="n">H. supp.</th><th class="n">Absences</th>
            <th class="n">Tarif/heure</th><th class="n">Salaire brut calculé</th><th class="n">Avances</th><th class="n">Autres retenues</th><th class="n">Net restant à payer</th></tr></thead><tbody>
            ${p.secretaires.map((s, i) => `<tr class="cliquable" data-i="${i}" title="Voir les heures de chaque journée">
              <td><strong>${esc(s.prenom)} ${esc(s.nom)}</strong>${s.incomplets.length ? ` ${etat('attention', `${s.incomplets.length} incomplet(s)`)}` : ''}</td>
              <td class="n">${s.jours_travailles}</td><td class="n">${H(s.minutes)}</td><td class="n">${tx.hs_seuil_minutes != null || s.minutes_hs ? H(s.minutes_hs) : '—'}</td>
              <td class="n">${s.absences}</td><td class="n">${s.taux_appliques.map(F).join(' / ')}</td><td class="n">${F(s.salaire_brut)}</td>
              <td class="n">${F(s.avances_total)}</td><td class="n">${F(s.retenues_total)}</td>
              <td class="n ${s.solde_negatif ? 'negatif' : ''}"><strong>${F(s.net)}</strong>${s.solde_negatif ? '<br><small>à examiner</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="vide">Aucune secrétaire concernée par ce mois.</td></tr>'}
            ${p.secretaires.length ? `<tr class="total"><td>TOTAL</td><td class="n">${T.jours_travailles}</td><td class="n">${H(T.minutes)}</td><td class="n">${H(T.minutes_hs)}</td><td class="n">${T.absences}</td><td class="n">—</td>
              <td class="n">${F(T.salaire_brut)}</td><td class="n">${F(T.avances)}</td><td class="n">${F(T.retenues)}</td><td class="n">${F(T.net)}</td></tr>` : ''}
          </tbody></table></div>
          <p class="mut">Cliquez sur une ligne pour voir les heures de chaque journée.</p>
        </div>
        <div class="carte"><h2>Récapitulatif de fin de mois</h2><div class="table-wrap"><table><thead><tr><th>Secrétaire</th><th class="n">Heures travaillées</th><th class="n">Tarif/heure</th><th class="n">Salaire calculé</th></tr></thead><tbody>
          ${p.secretaires.map((s) => `<tr><td>${esc(s.prenom)} ${esc(s.nom)}</td><td class="n">${H(s.minutes)}</td><td class="n">${s.taux_appliques.map(F).join(' / ')}</td><td class="n">${F(s.salaire_brut)}</td></tr>`).join('')}
          <tr class="total"><td>TOTAL</td><td class="n">${H(T.minutes)}</td><td class="n">—</td><td class="n">${F(T.salaire_brut)}</td></tr></tbody></table></div></div>
        <div class="grille2">
          ${blocOperations('avances', 'Avances sur salaire', avances, clos)}
          ${blocOperations('retenues', 'Autres retenues autorisées', retenues, clos)}
        </div>`;

      zone.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => detailSecretaire(p.secretaires[Number(tr.dataset.i)], p)));
      const br = document.getElementById('btn-rouvrir');
      if (br) br.onclick = async () => {
        const r = await formModal({
          titre: `Rouvrir ${p.libelle_mois}`, bouton: 'Rouvrir le mois',
          intro: `<div class="bandeau attention">Réservé aux corrections exceptionnelles. La version validée est <strong>archivée intacte</strong> (consultable dans Historique) ; le mois redevient modifiable jusqu’à une nouvelle clôture. L’opération est tracée à votre nom.</div>`,
          champs: [{ name: 'justification', label: 'Justification (obligatoire)', type: 'textarea', required: true, aide: 'Ex. : départ de Bintou le 12/09 oublié, confirmé par la responsable.' }],
          onSubmit: (v) => api('POST', `/api/paie/${p.mois}/rouvrir`, v),
        });
        if (r) { toast(`${p.libelle_mois} est rouvert pour correction.`); charger(); }
      };
      const bc = document.getElementById('btn-cloturer');
      if (bc) bc.onclick = () => cloturer(p);
      const be = document.getElementById('btn-email');
      if (be) be.onclick = async () => {
        try { const r = await api('POST', `/api/paie/${m}/renvoyer-email`); toast(r.statut === 'envoye' ? `Récapitulatif envoyé à ${r.destinataire}.` : `E-mail non envoyé : ${r.erreur}`, r.statut !== 'envoye'); } catch (e) { toast(e.message, true); }
      };
      for (const type of ['avances', 'retenues']) {
        const add = document.getElementById(`add-${type}`);
        if (add) add.onclick = () => ajouterOperation(type, m);
        zone.querySelectorAll(`[data-annuler-${type}]`).forEach((b) => b.addEventListener('click', async () => {
          const r = await formModal({
            titre: type === 'avances' ? 'Annuler cette avance' : 'Annuler cette retenue', bouton: 'Confirmer l’annulation',
            intro: '<p class="mut">L’opération reste dans l’historique, marquée annulée.</p>',
            champs: [{ name: 'justification', label: 'Motif de l’annulation', type: 'textarea', required: true }],
            onSubmit: (v) => api('POST', `/api/${type}/${b.dataset[`annuler${type === 'avances' ? 'Avances' : 'Retenues'}`]}/annuler`, v),
          });
          if (r) { toast('Opération annulée.'); charger(); }
        }));
      }
    }

    function blocOperations(type, titre, ops, clos) {
      const attr = `data-annuler-${type}`;
      return `<div class="carte"><div class="entete-page" style="margin-bottom:.5rem"><h2 style="margin:0">${titre}</h2>${!clos ? `<button class="petit" id="add-${type}">+ Enregistrer</button>` : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Secrétaire</th><th class="n">Montant</th><th>Motif</th><th>Enregistrée par</th><th></th></tr></thead><tbody>
        ${ops.map((o) => `<tr class="${o.annule ? 'annule' : ''}"><td>${dateFr(o.date_operation)}</td><td>${esc(o.secretaire)}</td><td class="n">${F(o.montant)}</td>
          <td>${esc(o.motif || '')}${o.annule ? `<br><small>Annulée par ${esc(o.annule_par_nom)} : ${esc(o.motif_annulation)}</small>` : ''}</td><td>${esc(o.cree_par_nom)}<br><small class="mut">${esc(dtLocal(o.cree_le))}</small></td>
          <td>${!clos && !o.annule ? `<button class="danger petit" ${attr}="${o.id}">Annuler</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="vide">Aucune opération imputée sur ce mois.</td></tr>'}
        </tbody></table></div></div>`;
    }

    async function ajouterOperation(type, m) {
      const av = type === 'avances';
      const debutMois = `${m}-01`;
      const auj = nowBamako().date;
      const r = await formModal({
        titre: av ? 'Enregistrer une avance sur salaire' : 'Enregistrer une retenue autorisée',
        intro: `<p class="mut">Elle sera déduite <strong>une seule fois</strong>, du salaire du mois d’imputation choisi.</p>`,
        champs: [
          { name: 'secretaire_id', label: 'Secrétaire', type: 'select', required: true, options: [{ value: '', label: '— Choisir —' }, ...secs.filter((s) => !s.archive).map((s) => ({ value: s.id, label: `${s.prenom} ${s.nom}${s.actif ? '' : ' (inactive)'}` }))] },
          { name: 'montant', label: 'Montant (F CFA)', type: 'number', required: true, attrs: 'min="1" step="1" inputmode="numeric"' },
          { name: 'date_operation', label: av ? 'Date de versement' : 'Date', type: 'date', required: true, value: auj.startsWith(m) ? auj : debutMois },
          { name: 'mois_imputation', label: 'Déduire du salaire de', type: 'month', required: true, value: m },
          { name: 'motif', label: av ? 'Motif (facultatif)' : 'Motif (obligatoire)', type: 'textarea', required: !av },
        ],
        onSubmit: (v) => api('POST', `/api/${type}`, { ...v, montant: Number(v.montant) }),
      });
      if (r) { toast(av ? 'Avance enregistrée.' : 'Retenue enregistrée.'); charger(); }
    }

    function detailSecretaire(s, p) {
      const lib = { complet: ['ok', 'Complet'], incomplet: ['attention', 'Départ manquant'], en_cours: ['info', 'En cours'], invalide: ['erreur', 'Invalide'] };
      infoModal(`${s.prenom} ${s.nom} — ${p.libelle_mois}`, `
        <div class="kpis"><div class="kpi"><div class="lib">Jours travaillés</div><div class="val">${s.jours_travailles}</div></div>
          <div class="kpi"><div class="lib">Heures</div><div class="val">${H(s.minutes)}</div></div>
          <div class="kpi"><div class="lib">Salaire calculé</div><div class="val">${F(s.salaire_brut)}</div></div>
          <div class="kpi"><div class="lib">Reste à payer</div><div class="val ${s.solde_negatif ? 'negatif' : ''}">${F(s.net)}</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Arrivée → départ</th><th class="n">Durée</th><th class="n">H. supp.</th><th class="n">Tarif</th><th class="n">Montant</th><th>Statut</th></tr></thead><tbody>
        ${s.jours.map((j) => `<tr><td>${JOURS[new Date(j.date + 'T12:00:00Z').getUTCDay()].slice(0, 3)}. ${dateFr(j.date)}</td>
          <td>${j.presences.map((x) => `${x.arrivee} → ${x.depart || '—'}${x.corrige ? ' <small>(corrigé)</small>' : ''}`).join('<br>')}</td>
          <td class="n">${H(j.minutes)}</td><td class="n">${H(j.minutes_hs)}</td><td class="n">${F(j.taux)}</td><td class="n">${F(j.montant)}</td><td>${etat(...lib[j.statut])}</td></tr>`).join('') || '<tr><td colspan="7" class="vide">Aucun pointage.</td></tr>'}
        <tr class="total"><td>Cumul</td><td></td><td class="n">${H(s.minutes)}</td><td class="n">${H(s.minutes_hs)}</td><td></td><td class="n">${F(s.salaire_brut)}</td><td></td></tr>
        </tbody></table></div>
        ${s.dates_absence.length ? `<p class="mut">Absences (${s.absences}) : ${s.dates_absence.map(dateFr).join(', ')}</p>` : ''}
        ${s.salaire_exact != null && s.salaire_exact !== s.salaire_brut ? `<p class="mut">Montant exact avant arrondi : ${String(s.salaire_exact).replace('.', ',')} F (arrondi au franc : ${F(s.salaire_brut)}).</p>` : ''}
        <p>Salaire calculé ${F(s.salaire_brut)} − avances ${F(s.avances_total)} − retenues ${F(s.retenues_total)} = <strong class="${s.solde_negatif ? 'negatif' : ''}">${F(s.net)}</strong></p>`);
    }

    async function cloturer(p) {
      const inc = p.totaux.incomplets;
      const champs = [{ name: 'commentaire', label: 'Commentaire (facultatif)', type: 'textarea' }];
      if (inc) champs.unshift({ name: 'confirmer_incomplets', label: `Je confirme la clôture malgré ${inc} pointage(s) incomplet(s), qui ne seront pas payés`, type: 'checkbox' });
      const r = await formModal({
        titre: `Valider et clôturer ${p.libelle_mois}`, bouton: 'Valider définitivement',
        intro: `<div class="bandeau attention">La clôture est <strong>définitive</strong> : les heures, le tarif, les avances et les montants de ${esc(p.libelle_mois)} seront figés et ne pourront plus être modifiés.</div>
          <p>Total des heures : <strong>${H(p.totaux.minutes)}</strong><br>Salaires calculés : <strong>${F(p.totaux.salaire_brut)}</strong><br>Avances : <strong>${F(p.totaux.avances)}</strong> — Retenues : <strong>${F(p.totaux.retenues)}</strong><br>Reste à payer : <strong>${F(p.totaux.net)}</strong></p>`,
        champs,
        onSubmit: (v) => api('POST', `/api/paie/${p.mois}/cloturer`, { confirmer_incomplets: !!v.confirmer_incomplets, commentaire: v.commentaire }),
      });
      if (r) {
        toast(`Paie de ${p.libelle_mois} validée et clôturée.`);
        if (r.email) toast(r.email.statut === 'envoye' ? `Récapitulatif envoyé à ${r.email.destinataire}.` : `Récapitulatif e-mail non envoyé : ${r.email.erreur}`, r.email.statut !== 'envoye');
        charger();
      }
    }

    await charger();
  }

  // ---------- Historique ----------
  async function pageHistorique(el) {
    const [clotures, emails, corrections, archives, tentatives] = await Promise.all([api('GET', '/api/clotures'), api('GET', '/api/emails'), api('GET', '/api/corrections'), api('GET', '/api/clotures/archives'), api('GET', '/api/tentatives')]);
    const libE = { envoye: ['ok', 'Envoyé'], non_envoye: ['attention', 'Non envoyé'], echec: ['erreur', 'Échec'] };
    el.innerHTML = `<div class="entete-page"><div><h1>Historique</h1><p>Rapports des mois clôturés, e-mails envoyés et corrections de pointage.</p></div></div>
      <div class="carte"><h2>Mois clôturés</h2><div class="table-wrap"><table><thead><tr><th>Mois</th><th class="n">Heures</th><th class="n">Salaires calculés</th><th class="n">Avances</th><th class="n">Reste à payer</th><th>Validé</th><th>Rapports</th></tr></thead><tbody>
      ${clotures.map((c) => `<tr><td><strong>${esc(c.libelle)}</strong></td><td class="n">${H(c.totaux.minutes)}</td><td class="n">${F(c.totaux.salaire_brut)}</td><td class="n">${F(c.totaux.avances)}</td><td class="n">${F(c.totaux.net)}</td>
        <td>${esc(dtLocal(c.valide_le))}<br><small>${esc(c.valide_par)}</small></td>
        <td class="actions"><a class="btn sec petit" href="/api/paie/${c.mois}/rapport.pdf" target="_blank" rel="noopener">PDF</a><a class="btn sec petit" href="/api/paie/${c.mois}/rapport.xlsx">Excel</a><a class="btn sec petit" href="#/salaires" data-mois="${c.mois}">Détail</a></td></tr>`).join('') || '<tr><td colspan="7" class="vide">Aucun mois clôturé pour l’instant.</td></tr>'}
      </tbody></table></div></div>
      <div class="carte"><h2>E-mails envoyés</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Objet</th><th>Destinataire</th><th>État</th><th></th></tr></thead><tbody>
      ${emails.map((e, i) => `<tr><td>${esc(dtLocal(e.cree_le))}</td><td>${e.mois ? `Récapitulatif de ${esc(moisLib(e.mois))}` : esc(e.sujet.replace(/^\[[^\]]*\]\s*/, ''))}</td><td>${esc(e.destinataire || '—')}</td><td>${etat(...libE[e.statut])}${e.erreur ? `<br><small>${esc(e.erreur)}</small>` : ''}</td>
        <td><button class="sec petit" data-mail="${i}">Voir</button></td></tr>`).join('') || '<tr><td colspan="5" class="vide">Aucun e-mail.</td></tr>'}
      </tbody></table></div></div>
      ${archives.length ? `<div class="carte"><h2>Versions archivées (mois rouverts pour correction)</h2><div class="table-wrap"><table><thead><tr><th>Mois</th><th class="n">Salaires</th><th class="n">Reste à payer</th><th>Validée</th><th>Rouverte</th><th>Justification</th><th>Rapports</th></tr></thead><tbody>
      ${archives.map((a) => `<tr><td>${esc(a.libelle)}</td><td class="n">${F(a.totaux.salaire_brut)}</td><td class="n">${F(a.totaux.net)}</td><td>${esc(dtLocal(a.valide_le))}<br><small>${esc(a.valide_par)}</small></td><td>${esc(dtLocal(a.rouvert_le))}<br><small>${esc(a.rouvert_par)}</small></td><td>${esc(a.justification)}</td>
        <td class="actions"><a class="btn sec petit" href="/api/clotures/archives/${a.id}/rapport.pdf" target="_blank" rel="noopener">PDF</a><a class="btn sec petit" href="/api/clotures/archives/${a.id}/rapport.xlsx">Excel</a></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
      <div class="carte"><h2>Tentatives de pointage (300 dernières)</h2><p class="mut">Chaque scan est consigné avec l’heure du serveur et le résultat des vérifications (QR, position GPS).</p><div class="table-wrap"><table><thead><tr><th>Date et heure</th><th>Secrétaire</th><th>Moyen</th><th>Résultat</th><th>Détail</th><th class="n">Distance</th><th class="n">Précision GPS</th></tr></thead><tbody>
      ${tentatives.map((x) => `<tr><td>${esc(x.cree_le_local)}</td><td>${esc(x.secretaire || 'Inconnu')}</td><td>${x.source === 'telephone' ? 'Téléphone' : 'Badge'}</td>
        <td>${x.resultat === 'accepte' ? etat('ok', x.type === 'depart' ? 'Départ enregistré' : 'Arrivée enregistrée') : etat('erreur', 'Refusé')}</td><td>${esc(x.motif || '')}</td>
        <td class="n">${x.distance_m != null ? `${x.distance_m} m` : '—'}</td><td class="n">${x.precision_m != null ? `± ${x.precision_m} m` : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="vide">Aucune tentative enregistrée.</td></tr>'}
      </tbody></table></div></div>
      <div class="carte"><h2>Corrections de pointage</h2>${tableauCorrections(corrections)}</div>`;
    el.querySelectorAll('[data-mail]').forEach((b) => b.addEventListener('click', () => {
      const e = emails[Number(b.dataset.mail)];
      infoModal(e.sujet, `<pre style="white-space:pre-wrap;font-family:inherit">${esc(e.corps)}</pre>`);
    }));
    el.querySelectorAll('[data-mois]').forEach((a) => a.addEventListener('click', () => { state.mois = a.dataset.mois; }));
  }

  // ---------- Paramètres ----------
  async function pageParametres(el) {
    const [taux, params, users] = await Promise.all([api('GET', '/api/taux'), api('GET', '/api/parametres'), api('GET', '/api/utilisateurs')]);
    const jours = params.jours_ouvrables.split(',');
    el.innerHTML = `<div class="entete-page"><div><h1>Paramètres</h1></div></div>
      <div class="carte"><h2>Tarif horaire et heures supplémentaires</h2>
        <p class="mut">Chaque tarif s’applique à partir de sa date d’effet. Les jours antérieurs gardent l’ancien tarif et les mois clôturés ne sont jamais recalculés.</p>
        <div class="table-wrap"><table><thead><tr><th>À partir du</th><th class="n">Tarif/heure</th><th>Heures supplémentaires</th><th>Enregistré par</th></tr></thead><tbody>
        ${taux.map((x) => `<tr><td>${x.date_effet === '2000-01-01' ? 'Origine' : dateFr(x.date_effet)}</td><td class="n"><strong>${F(x.taux)}</strong></td>
          <td>${x.hs_seuil_minutes != null ? `Au-delà de ${H(x.hs_seuil_minutes)}/jour, majoration ${x.hs_majoration_pct} %` : 'Non configurées'}</td><td>${esc(x.cree_par_nom || 'Paramétrage initial')}</td></tr>`).join('')}
        </tbody></table></div>
        <button id="btn-taux" style="margin-top:.8rem">Définir un nouveau tarif</button></div>
      <div class="carte"><h2>Pointage par téléphone</h2><form id="f-tel">
        <div class="champ"><label>Type de QR code de la boutique</label><div class="cases" style="flex-direction:column;gap:.5rem">
          <label><input type="radio" name="qr_mode" value="dynamique" ${params.qr_mode === 'dynamique' ? 'checked' : ''}> <span><strong>Dynamique (recommandé)</strong> — affiché sur la tablette ou l’écran de la boutique (page « Pointage QR »), il change toutes les 30 secondes. Une photo du QR ne permet pas de pointer depuis chez soi.</span></label>
          <label><input type="radio" name="qr_mode" value="fixe" ${params.qr_mode === 'fixe' ? 'checked' : ''}> <span><strong>Fixe</strong> — QR imprimé et collé au mur. Pas d’écran nécessaire, mais une photo du QR suffit pour pointer : activez alors le contrôle GPS.</span></label>
        </div></div>
        <div class="champ"><label for="adr">Adresse du serveur pour les téléphones</label><input id="adr" value="${esc(params.adresse_publique)}" placeholder="${esc(params.adresses_reseau[0] ? `http://${params.adresses_reseau[0]}:${location.port || 80}` : 'https://pointage.mondomaine.com')}">
          <div class="aide">Adresse que les téléphones utilisent pour joindre ce serveur (Wi-Fi de la boutique ou Internet). ${params.adresses_reseau.length ? `Adresse(s) de ce serveur sur le réseau local : ${params.adresses_reseau.map((a) => `<code>http://${esc(a)}:${esc(location.port || '80')}</code>`).join(', ')}.` : ''} Laisser vide pour utiliser l’adresse actuelle (${esc(params.adresse_actuelle)}).</div></div>
        <div class="champ"><label>Contrôle GPS (facultatif) : pointage accepté seulement près de la boutique</label>
          <div class="ligne">
            <div class="champ"><label for="glat" class="aide">Latitude</label><input id="glat" inputmode="decimal" value="${esc(params.gps_lat)}" placeholder="12.6392"></div>
            <div class="champ"><label for="glon" class="aide">Longitude</label><input id="glon" inputmode="decimal" value="${esc(params.gps_lon)}" placeholder="-8.0029"></div>
            <div class="champ"><label for="gray" class="aide">Rayon (mètres)</label><input id="gray" type="number" min="20" max="5000" value="${esc(params.gps_rayon_m)}" placeholder="100"></div>
          </div>
          <div class="actions" style="margin-top:.5rem"><button type="button" class="sec petit" id="btn-gps">Utiliser ma position actuelle (à faire dans la boutique)</button><button type="button" class="sec petit" id="btn-gps-off">Désactiver le contrôle GPS</button></div>
          <div class="aide">Laisser vide pour ne pas contrôler la position. Le GPS exige que l’application soit en https. Il dissuade la fraude, mais une position peut être falsifiée : le QR dynamique reste la meilleure protection.</div></div>
        <div class="actions"><button type="submit">Enregistrer</button><a class="btn sec" href="/api/qr-boutique/fixe.pdf">Télécharger le QR fixe (PDF)</a><button type="button" class="sec" id="btn-qr-fixe">Imprimer le QR fixe</button><button type="button" class="sec" id="btn-qr-regen">Remplacer le QR fixe</button></div>
      </form><div class="impr-qr" id="impr-qr"></div></div>
      <div class="grille2">
        <div class="carte"><h2>Calendrier et notifications</h2><form id="f-params">
          <div class="champ"><label>Jours ouvrables (pour compter les absences)</label><div class="cases">
            ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="j" value="${d}" ${jours.includes(String(d)) ? 'checked' : ''}> ${JOURS[d]}</label>`).join('')}</div></div>
          <div class="champ"><label for="email">E-mail de l’administrateur (récapitulatif mensuel)</label><input id="email" type="email" value="${esc(params.email_admin)}">
            <div class="aide">Serveur d’envoi (SMTP) : ${params.smtp ? '<span class="etat ok">configuré</span>' : '<span class="etat attention">non configuré — voir le fichier .env</span>'}</div></div>
          <div class="champ"><div class="cases"><label><input type="checkbox" id="notif" ${params.notif_pointage ? 'checked' : ''}> Recevoir un e-mail à chaque arrivée et départ d’une secrétaire</label></div>
            <div class="aide">Envoyé à l’adresse ci-dessus, avec l’heure de Bamako et, au départ, la durée de présence. Désactivé par défaut.</div></div>
          <button type="submit">Enregistrer</button></form></div>
        <div class="carte"><h2>Comptes</h2>
          <div class="table-wrap"><table><thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th></th></tr></thead><tbody>
          ${users.map((u) => `<tr><td>${esc(u.nom_complet)}</td><td>${esc(u.nom_utilisateur)}</td><td>${u.role === 'admin' ? 'Administrateur' : 'Poste de pointage'}</td>
            <td>${u.id !== state.user.id ? `<button class="sec petit" data-u="${u.id}" data-actif="${u.actif ? 0 : 1}">${u.actif ? 'Désactiver' : 'Réactiver'}</button>` : '<span class="mut">vous</span>'}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="mut">Un compte « Poste de pointage » ne peut que scanner les badges : idéal pour la tablette de la boutique.</p>
          <div class="actions"><button id="btn-user">+ Créer un compte</button><button class="sec" id="btn-mdp">Changer mon mot de passe</button></div></div>
      </div>`;

    document.getElementById('btn-taux').onclick = async () => {
      const actuel = taux[0];
      const r = await formModal({
        titre: 'Nouveau tarif horaire',
        champs: [
          { name: 'date_effet', label: 'Applicable à partir du', type: 'date', required: true, value: nowBamako().date },
          { name: 'taux', label: 'Tarif (F CFA par heure)', type: 'number', required: true, value: actuel.taux, attrs: 'min="1" step="1"' },
          { name: 'hs_seuil_heures', label: 'Heures supplémentaires au-delà de (heures par jour)', type: 'number', value: actuel.hs_seuil_minutes != null ? actuel.hs_seuil_minutes / 60 : '', attrs: 'min="1" max="24" step="0.5"', aide: 'Laisser vide pour ne pas calculer d’heures supplémentaires.' },
          { name: 'hs_majoration_pct', label: 'Majoration des heures supplémentaires (%)', type: 'number', value: actuel.hs_majoration_pct, attrs: 'min="0" max="200" step="1"', aide: '0 % : les heures supplémentaires sont affichées et payées au tarif normal.' },
        ],
        onSubmit: (v) => api('POST', '/api/taux', v),
      });
      if (r) { toast('Tarif enregistré.'); route(); }
    };
    document.getElementById('f-tel').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/parametres', {
          qr_mode: e.target.querySelector('input[name=qr_mode]:checked').value,
          adresse_publique: document.getElementById('adr').value.trim(),
          gps_lat: document.getElementById('glat').value.trim(),
          gps_lon: document.getElementById('glon').value.trim(),
          gps_rayon_m: document.getElementById('gray').value.trim(),
        });
        toast('Paramètres du pointage par téléphone enregistrés.');
      } catch (err) { toast(err.message, true); }
    });
    document.getElementById('btn-gps').onclick = () => {
      if (!navigator.geolocation || !window.isSecureContext) return toast('Localisation indisponible : ouvrez l’application en https (ou sur ce poste via localhost).', true);
      navigator.geolocation.getCurrentPosition((p) => {
        document.getElementById('glat').value = p.coords.latitude.toFixed(6);
        document.getElementById('glon').value = p.coords.longitude.toFixed(6);
        if (!document.getElementById('gray').value) document.getElementById('gray').value = 100;
        toast(`Position relevée (précision ± ${Math.round(p.coords.accuracy)} m). Cliquez sur Enregistrer.`);
      }, () => toast('Position introuvable : autorisez la localisation.', true), { enableHighAccuracy: true, timeout: 15000 });
    };
    document.getElementById('btn-gps-off').onclick = () => {
      for (const id of ['glat', 'glon', 'gray']) document.getElementById(id).value = '';
      toast('Cliquez sur Enregistrer pour désactiver le contrôle GPS.');
    };
    document.getElementById('btn-qr-fixe').onclick = async () => {
      const q = await api('GET', '/api/qr-boutique/fixe');
      document.getElementById('impr-qr').innerHTML = `<h1>${esc(state.entreprise)}</h1><p>Pointage des secrétaires<br>Scannez avec votre téléphone à l’arrivée et au départ</p><img src="${q.qr}" alt="">`;
      infoModal('QR code fixe de la boutique', `<div style="text-align:center">${!q.actif ? '<div class="bandeau attention" style="text-align:left">Le mode actuel est « dynamique » : ce QR fixe ne sera accepté qu’après avoir choisi le mode « Fixe » et enregistré.</div>' : ''}
        ${q.adresse_locale ? '<div class="bandeau erreur" style="text-align:left">Ce QR contient « localhost » : renseignez d’abord l’adresse du serveur pour les téléphones.</div>' : ''}
        <img src="${q.qr}" alt="QR fixe" style="width:280px;max-width:100%;image-rendering:pixelated"><p class="actions" style="justify-content:center"><button id="btn-impr-qr">Imprimer</button><a class="btn sec" href="/api/qr-boutique/fixe.pdf">Télécharger en PDF</a></p></div>`, false);
      document.getElementById('btn-impr-qr').onclick = () => window.print();
    };
    document.getElementById('btn-qr-regen').onclick = async () => {
      const r = await formModal({
        titre: 'Remplacer le QR fixe', bouton: 'Remplacer',
        intro: '<p>L’ancien QR imprimé ne fonctionnera plus (par exemple s’il a été photographié et diffusé). Pensez à imprimer et afficher le nouveau.</p>',
        champs: [], onSubmit: () => api('POST', '/api/qr-boutique/fixe/regenerer'),
      });
      if (r) toast('Nouveau QR fixe généré : imprimez-le.');
    };
    document.getElementById('f-params').addEventListener('submit', async (e) => {
      e.preventDefault();
      const j = [...e.target.querySelectorAll('input[name=j]:checked')].map((x) => x.value).join(',');
      try { await api('PUT', '/api/parametres', { jours_ouvrables: j, email_admin: document.getElementById('email').value.trim(), notif_pointage: document.getElementById('notif').checked }); toast('Paramètres enregistrés.'); } catch (err) { toast(err.message, true); }
    });
    document.getElementById('btn-user').onclick = async () => {
      const r = await formModal({
        titre: 'Créer un compte',
        champs: [
          { name: 'nom_complet', label: 'Nom complet', required: true },
          { name: 'nom_utilisateur', label: 'Identifiant', required: true, aide: '3 à 40 caractères : lettres, chiffres, . _ -' },
          { name: 'mot_de_passe', label: 'Mot de passe', type: 'password', required: true, aide: '8 caractères minimum.' },
          { name: 'role', label: 'Rôle', type: 'select', value: 'poste', options: [{ value: 'poste', label: 'Poste de pointage (scan uniquement)' }, { value: 'admin', label: 'Administrateur (accès complet)' }] },
        ],
        onSubmit: (v) => api('POST', '/api/utilisateurs', v),
      });
      if (r) { toast('Compte créé.'); route(); }
    };
    document.getElementById('btn-mdp').onclick = async () => {
      const r = await formModal({
        titre: 'Changer mon mot de passe',
        champs: [{ name: 'actuel', label: 'Mot de passe actuel', type: 'password', required: true }, { name: 'nouveau', label: 'Nouveau mot de passe', type: 'password', required: true, aide: '8 caractères minimum.' }],
        onSubmit: (v) => api('POST', '/api/mot-de-passe', v),
      });
      if (r) toast('Mot de passe modifié.');
    };
    el.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('PUT', `/api/utilisateurs/${b.dataset.u}/actif`, { actif: b.dataset.actif === '1' }); route(); } catch (e) { toast(e.message, true); }
    }));
  }

  route();
})();
