# Blog « Treks au Ladakh avec Stanzin »

Site statique des treks de Stanzin Tharpa (guide au Ladakh / Zanskar), tenu par une personne
novice. Répondre en français, simplement, et garder un fonctionnement à base de fichiers.

## Publication

- Dépôt : https://github.com/StanzinTharpaTrek/treks-ladakh (public).
- Site : https://stanzintharpatrek.github.io/treks-ladakh/, publié par GitHub Actions
  (`.github/workflows/publier.yml`) à chaque push sur `main`, en 1 à 2 minutes.
- Le contenu est surtout écrit depuis un téléphone avec **Pages CMS** (configuration `.pages.yml`),
  qui pousse directement sur GitHub : **toujours faire `git pull` avant de travailler.**
- Les commits doivent utiliser l'identité anonyme du dépôt (config Git locale) :
  `StanzinTharpaTrek <343981794+StanzinTharpaTrek@users.noreply.github.com>`.
  Ne jamais utiliser l'adresse professionnelle de l'utilisateur.

## Organisation

- `contenu/accueil/introduction.txt` : 1re ligne = titre du blog, puis le texte d'introduction.
- `contenu/accueil/<image>` : la photo d'en-tête (une seule image dans ce dossier).
- `contenu/accueil/images-introduction.yml` : carte du monde, carte zoomée et photo de Stanzin
  autour de l'introduction (menu CMS « Accueil (images autour de l'introduction) »).
- `contenu/accueil/contact.txt` : la page Contact.
- `contenu/histoires/*.md` : histoires écrites avec Pages CMS (front matter YAML, étapes, photos) ;
  l'ancien format « un dossier + texte.txt + photos » reste accepté.
- `contenu/photos/` : photos envoyées par Pages CMS (référencées `photos/<nom>`).
- `contenu/racine/` : fichiers copiés tels quels à la racine du site (clé IndexNow, etc.).
- `modele/page.html` et `modele/style.css` : gabarit et style de toutes les pages.
- `outils/construire.js` : génère `site/` (photos réduites en WebP, mises en cache dans `.cache-photos/`).
- `MODE D'EMPLOI.txt` : notice pour l'utilisatrice ou l'utilisateur ; la mettre à jour quand un menu du CMS change.

## Commandes

- `npm run build` : génère le site dans `site/`.
- `Aperçu du site.bat` (ou `npm run apercu`) : génère, allège les grosses photos, vérifie
  l'orthographe (`orthographe.html`) et ouvre l'aperçu.
- `npm install` est nécessaire sur un nouveau PC (le module `sharp` dépend de la machine).

## Points d'attention

- Accueil : sur un écran large (plus de 1100px), une seule ligne carte | zoom | texte | photo. Les images
  prennent la hauteur exacte du texte (script dans `modele/page.html`, recadrage `object-fit: cover`).
  En dessous de 1100px, les cartes passent au-dessus du texte.
- `style.css` est appelé avec une empreinte (`?v=…`) pour que les navigateurs ne gardent pas une
  ancienne version.
- Les images que l'utilisateur dit avoir « ajoutées à la racine » sont en général dans `C:\IA Perso`
  (le dossier parent du blog), et leur nom ou extension cité peut être approximatif.
- Vérifier un changement visuel avant de publier : sur ce PC, Edge en mode sans fenêtre
  (`msedge.exe --headless=new --screenshot`) permet de faire des captures de `site/index.html`.
