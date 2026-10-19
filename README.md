# Djenepo Couture & Shopping — Pointage QR et salaires horaires

Application web de pointage par QR code avec calcul automatique des salaires à **125 F CFA par heure travaillée et validée**.

## Démarrage

Prérequis : Node.js 22.5 ou plus récent (base SQLite intégrée à Node, rien d'autre à installer).

```bash
npm install
npm start
```

Ouvrir `http://localhost:3000`. À la première ouverture, créez le compte administrateur (responsable).

Tester avec des données fictives (base séparée `data/demo.db`, port 3001) :

```bash
npm run demo
```

Comptes de démonstration : `demo` / `demo-dcs-2026` (administrateur) et `tablette` / `tablette-dcs-2026` (poste de pointage).

Lancer les tests de calcul :

```bash
npm test
```

## Utilisation

### Pointage avec le téléphone des secrétaires

1. **Paramètres › Pointage par téléphone** : saisissez l'adresse à laquelle les téléphones joignent le serveur. Sur le Wi-Fi de la boutique, c'est par exemple `http://192.168.1.20:3000` (l'adresse exacte est indiquée sur la page et au démarrage du serveur). Si l'application est hébergée sur Internet, c'est son adresse https.
2. **Secrétaires › Activer son téléphone** : un QR d'activation s'affiche. La secrétaire le scanne une seule fois avec l'appareil photo de son téléphone. Le QR est à usage unique et valable 24 h. Il faut un seul téléphone par secrétaire : en activer un nouveau désactive l'ancien.
3. **Pointage QR** : ouvrez cette page sur la tablette ou l'écran de la boutique, avec un compte « Poste de pointage » (Paramètres › Comptes). Les secrétaires scannent le QR affiché avec leur téléphone : le 1er scan enregistre l'arrivée, le 2e le départ. Plusieurs passages par jour sont possibles (pause déjeuner).
   - **QR dynamique (par défaut)** : il change toutes les 30 secondes. Une photo du QR ne permet pas de pointer plus tard depuis chez soi.
   - **QR fixe** : il est imprimé et collé au mur (Paramètres › Imprimer le QR fixe). Dans ce mode, activez le **contrôle GPS** : le pointage n'est alors accepté qu'à proximité de la boutique.
4. Le badge QR personnel scanné sur la tablette reste disponible en secours (téléphone oublié ou déchargé).

### Gestion

1. **Secrétaires** : ajout des secrétaires, activation et désactivation de leur téléphone (téléphone perdu ou changé), badge de secours.
4. **Salaires et rémunérations** : choisissez le mois et l'année. Pour chaque secrétaire : jours travaillés, heures, heures supplémentaires, absences, tarif, salaire brut, avances, retenues, net à payer. Cliquez sur une ligne pour voir les heures de chaque jour.
5. **Avances et retenues** : enregistrées depuis la page Salaires, avec le montant, la date, le motif et le nom de l'administrateur. Chacune est rattachée à un seul mois de déduction.
6. **Clôture** : une fois le mois terminé, « Valider et clôturer le mois » fige définitivement les montants et envoie le récapitulatif par e-mail.
7. **Historique** : anciens rapports PDF/Excel, e-mails envoyés et corrections de pointage.

## Règles de calcul

- Salaire = heures travaillées × tarif horaire. Exemple : 09 h 00 → 17 h 00 = 8 h × 125 = 1 000 F.
- Les durées sont calculées à partir de l'heure du **serveur**, dans le fuseau **Africa/Bamako**.
- Les présences qui se chevauchent sont fusionnées : aucune heure n'est comptée deux fois.
- Une arrivée sans départ n'est **pas comptée**. Elle est signalée « départ manquant » jusqu'à sa correction. Le jour même, elle apparaît « en cours ».
- Les montants sont calculés à la minute près. Le salaire mensuel est arrondi au franc une seule fois, sur la durée totale.
- Reste à payer = salaire calculé − avances − autres retenues autorisées. Un solde négatif est signalé « à examiner ». Il n'est jamais reporté automatiquement sur le mois suivant.
- Absences = jours ouvrables écoulés (lundi à samedi par défaut, modifiable) sans aucun pointage, à partir de la date d'embauche.
- Heures supplémentaires : désactivées par défaut. Dans Paramètres, on peut fixer un seuil journalier (ex. 8 h) et une majoration en %.
- Chaque tarif est enregistré avec sa date d'effet. Un changement de tarif ne modifie jamais les jours précédents, ni les mois clôturés.
- Correction d'un pointage : la justification est obligatoire. L'ancienne valeur, la nouvelle valeur, l'auteur et la date sont conservés. Un pointage n'est jamais supprimé : il peut seulement être annulé.
- Un mois clôturé ne peut plus être modifié (pointages, avances, retenues, tarif). Son rapport est figé.
- Calcul automatique de fin de mois : dès le 1er du mois, la paie du mois écoulé est calculée et signalée « à valider » sur le tableau de bord. La clôture reste une décision de l'administrateur.

## E-mails à l'administrateur

1. Renseignez l'adresse de l'administrateur dans **Paramètres**.
2. Copiez `.env.example` en `.env` et remplissez les paramètres SMTP (sur Railway : variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` du service).

**Récapitulatif mensuel** : envoyé à la clôture du mois, avec le rapport PDF. Sans configuration, la clôture fonctionne quand même. L'e-mail est alors conservé dans l'Historique avec l'état « non envoyé » et peut être renvoyé plus tard.

**Notification d'arrivée et de départ** (facultative, désactivée par défaut) : cochez « Recevoir un e-mail à chaque arrivée et départ » dans **Paramètres › Calendrier et notifications**. À chaque pointage (badge ou téléphone), l'administrateur reçoit un court message : nom de la secrétaire, arrivée ou départ, date et heure de Bamako et, au départ, la durée de présence. L'envoi se fait en arrière-plan : un serveur SMTP lent ou en panne ne retarde ni ne bloque jamais le pointage. Chaque notification est consignée dans l'Historique (« envoyé », « non envoyé » si l'adresse ou le SMTP manque, ou « échec »).

## Sécurité

- Mots de passe chiffrés (bcrypt). Session dans un cookie HttpOnly / SameSite=Strict. Protection anti-CSRF.
- Après 5 tentatives de connexion échouées, l'accès est bloqué 15 minutes.
- Le compte « poste de pointage » n'a pas accès aux salaires.
- Un badge perdu peut être remplacé (« Nouveau badge ») : l'ancien QR code ne fonctionne plus.
- Un même badge ne peut pas être scanné deux fois dans la même minute.
- Le téléphone de chaque secrétaire est identifié par un jeton secret, remis lors de l'activation et stocké dans un cookie HttpOnly. La secrétaire n'a aucun mot de passe à retenir.
- Le scan avec l'appareil photo du téléphone fonctionne aussi en HTTP sur le Wi-Fi de la boutique. En revanche, le **contrôle GPS** et le bouton « Scanner » de la page téléphone exigent le **HTTPS**. Ensuite, mettez `COOKIE_SECURE=1`.
- Sauvegardez régulièrement le dossier `data/`.

## Structure

| Fichier | Rôle |
|---|---|
| `src/payroll.js` | Moteur de calcul des heures et des salaires |
| `src/app.js` | API (pointage, secrétaires, corrections, avances, paie, clôture) |
| `src/telephone.js` | Pointage par téléphone : activation, QR de la boutique, contrôle GPS |
| `public/m.html`, `public/m.js` | Page ouverte sur le téléphone des secrétaires |
| `src/reports.js` | Rapports PDF et Excel |
| `src/mailer.js` | Récapitulatif mensuel et notifications de pointage par e-mail |
| `src/time.js` | Fuseau Africa/Bamako |
| `src/db.js` | Schéma de la base SQLite |
| `public/` | Interface web |
| `test/` | Tests du calcul et de l'API |
