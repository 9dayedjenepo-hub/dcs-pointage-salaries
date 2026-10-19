'use strict';
/* Page ouverte sur le téléphone de la secrétaire lorsqu'elle scanne un QR code DCS. */
(function () {
  const $etat = document.getElementById('etat');
  const $actions = document.getElementById('actions');
  const $jour = document.getElementById('jour');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let scanner = null;
  let occupe = false;

  // Le code est lu puis retiré de l'adresse : recharger la page ne repointe pas.
  const params = Object.fromEntries(location.hash.slice(1).split('&').filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
  if (location.hash) history.replaceState(null, '', location.pathname);

  const tic = () => {
    document.getElementById('horloge').textContent = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Africa/Bamako', hour: '2-digit', minute: '2-digit' });
  };
  tic();
  setInterval(tic, 10000);

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-DCS': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* vide */ }
    if (!res.ok) throw new Error(data?.erreur || `Erreur ${res.status}`);
    return data;
  }

  function afficher(classe, titre, detail = '') {
    $etat.className = `resultat-scan ${classe}`;
    $etat.innerHTML = `<div class="gros">${titre}</div>${detail ? `<div style="margin-top:.4rem">${detail}</div>` : ''}`;
  }

  function position() {
    return new Promise((ok, ko) => {
      if (!navigator.geolocation) return ko(new Error('La localisation n’est pas disponible sur ce téléphone.'));
      if (!window.isSecureContext) return ko(new Error('La localisation exige une connexion sécurisée (https). Prévenez la responsable.'));
      navigator.geolocation.getCurrentPosition(
        (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy }),
        (e) => ko(new Error(e.code === 1
          ? 'Autorisez la localisation pour ce site, puis scannez à nouveau le QR de la boutique.'
          : 'Position introuvable. Activez la localisation (GPS) et réessayez.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    });
  }

  async function afficherJour() {
    const moi = await api('GET', '/api/telephone/moi');
    document.getElementById('entreprise').textContent = moi.entreprise;
    if (!moi.active) return moi;
    $jour.hidden = false;
    $jour.innerHTML = `<h2>${esc(moi.secretaire)}</h2>
      <p class="mut">Aujourd’hui : ${moi.present ? '<span class="etat ok">présente</span>' : moi.presences.length ? '<span class="etat info">partie</span>' : '<span class="etat neutre">pas encore pointé</span>'}</p>
      ${moi.presences.length ? `<ul class="liste-jour">${moi.presences.map((p) => `<li>Arrivée <strong>${p.arrivee}</strong> — départ <strong>${p.depart || '…'}</strong></li>`).join('')}</ul>` : ''}`;
    return moi;
  }

  async function pointer(code, moi) {
    if (occupe) return;
    occupe = true;
    try {
      afficher('', 'Pointage en cours…', moi.gps_requis ? 'Vérification de votre position…' : '');
      const body = { code };
      if (moi.gps_requis) body.position = await position();
      const r = await api('POST', '/api/telephone/pointer', body);
      afficher(r.type, `${r.type === 'arrivee' ? 'Arrivée' : 'Départ'} enregistré${r.type === 'arrivee' ? 'e' : ''} à ${esc(r.heure)}`,
        `<div style="font-size:1.1rem">${esc(r.secretaire)}</div>${r.type === 'depart' ? `<div>Présence : ${Math.floor(r.minutes / 60)} h ${String(r.minutes % 60).padStart(2, '0')}</div>` : '<div>Bonne journée !</div>'}
        ${r.incomplet_precedent ? `<div style="margin-top:.4rem;color:#a35400">Votre départ du ${r.incomplet_precedent.split('-').reverse().join('/')} n’a pas été pointé : signalez-le à la responsable.</div>` : ''}`);
      if (navigator.vibrate) navigator.vibrate(150);
    } catch (e) {
      afficher('erreur', 'Pointage refusé', esc(e.message));
    } finally {
      occupe = false;
      await afficherJour().catch(() => {});
      boutonScanner(moi);
    }
  }

  function boutonScanner(moi) {
    $actions.innerHTML = '<button id="btn-scan" class="gros-bouton">Scanner le QR de la boutique</button>'
      + '<p class="mut">Vous pouvez aussi scanner le QR avec l’appareil photo du téléphone.</p>';
    document.getElementById('btn-scan').onclick = () => demarrerCamera(moi);
  }

  function chargerLibQr() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      s.onload = ok;
      s.onerror = () => ko(new Error('lecteur QR non chargé (connexion Internet ?)'));
      document.head.appendChild(s);
    });
  }

  async function demarrerCamera(moi) {
    if (scanner) return;
    try {
      await chargerLibQr();
      scanner = new window.Html5Qrcode('lecteur');
      $actions.innerHTML = '<button id="btn-stop" class="sec">Annuler</button>';
      document.getElementById('btn-stop').onclick = arreter;
      await scanner.start({ facingMode: 'environment' }, { fps: 8, qrbox: 230 }, async (texte) => {
        let code = null;
        try { code = new URL(texte).hash.slice(1).split('&').map((x) => x.split('=')).find(([k]) => k === 'c')?.[1]; } catch { /* pas une URL */ }
        if (!code) { afficher('erreur', 'QR non reconnu', 'Scannez le QR de pointage de la boutique.'); return; }
        await arreter();
        pointer(decodeURIComponent(code), moi);
      }, () => {});
    } catch (e) {
      await arreter();
      afficher('erreur', 'Caméra indisponible', `${esc(e.message || e)}<br>Utilisez l’appareil photo du téléphone pour scanner le QR.`);
    }
  }

  async function arreter() {
    if (scanner) { await scanner.stop().catch(() => {}); scanner = null; }
    document.getElementById('lecteur').innerHTML = '';
    boutonScanner(await api('GET', '/api/telephone/moi').catch(() => ({})));
  }

  (async function demarrer() {
    try {
      if (params.activer) {
        afficher('', 'Activation du téléphone…');
        try {
          const r = await api('POST', '/api/telephone/activer', { code: params.activer });
          afficher('arrivee', 'Téléphone activé', `Ce téléphone est maintenant relié à <strong>${esc(r.secretaire)}</strong>.<br>Pour pointer, scannez le QR de la boutique à chaque arrivée et à chaque départ.`);
        } catch (e) {
          afficher('erreur', 'Activation impossible', esc(e.message));
        }
      }
      const moi = await afficherJour();
      if (!moi.active) {
        if (!params.activer) afficher('erreur', 'Téléphone non activé', 'Demandez à la responsable de vous montrer votre QR d’activation, puis scannez-le avec ce téléphone.');
        $actions.innerHTML = '';
        return;
      }
      if (params.c) return pointer(params.c, moi);
      if (!params.activer) afficher('', 'Prête à pointer', 'Scannez le QR affiché à la boutique.');
      boutonScanner(moi);
    } catch (e) {
      afficher('erreur', 'Erreur', esc(e.message));
    }
  })();
})();
