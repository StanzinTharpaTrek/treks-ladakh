// Génère le site (dossier "site") à partir du dossier "contenu".
//
//   contenu/accueil/introduction.txt   1re ligne = titre du blog, puis le texte d'introduction
//   contenu/accueil/<une image>        photo d'en-tête
//   contenu/histoires/<dossier>/       un dossier par histoire :
//       <un fichier .txt>              1re ligne = titre, puis le texte
//       <des images>                   la 1re (ou celle nommée "couverture") sert de vignette
//
// Les photos sont toujours réduites et converties en WebP pour le site.
// Avec l'option --alleger, les grosses photos du dossier "contenu" sont en plus
// remplacées par une version allégée (l'original est rangé dans "originaux"),
// pour que l'envoi en ligne soit rapide même avec une connexion faible.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const YAML = require("yaml");

const RACINE = path.resolve(__dirname, "..");
const CONTENU = path.join(RACINE, "contenu");
const MODELE = path.join(RACINE, "modele");
const SORTIE = path.join(RACINE, "site");
const ORIGINAUX = path.join(RACINE, "originaux");
const CACHE = path.join(RACINE, ".cache-photos");
const PHOTOS_CMS = path.join(CONTENU, "photos");   // photos envoyées avec Pages CMS
const RACINE_PUBLIQUE = path.join(CONTENU, "racine"); // fichiers copiés tels quels (ex. vérification Google)
// Adresse publique du site (champ « homepage » de package.json), pour les liens complets.
const ADRESSE_SITE = require("../package.json").homepage.replace(/\/?$/, "/");
const pagesDuSite = [];

const IMAGES = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif", ".tif", ".tiff"];
const LARGEUR_SITE = 1600;      // largeur maximale des photos sur le site
const LARGEUR_ENTETE = 2400;    // la photo d'en-tête occupe tout l'écran
const LARGEUR_ALLEGEE = 2400;   // photos conservées dans "contenu" après --alleger
const POIDS_MAX_CONTENU = 800 * 1024;
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
  "août", "septembre", "octobre", "novembre", "décembre"];

const avertissements = [];

const echapper = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function lireTexte(fichier) {
  const brut = fs.readFileSync(fichier, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lignes = brut.trim().split("\n");
  const titre = lignes.shift().trim();
  const paragraphes = lignes.join("\n").trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { titre, paragraphes };
}

// Mots-clés reconnus en tête d'un fichier d'histoire (majuscules et accents facultatifs).
const CHAMPS = {
  "TITRE": "titre", "LIEU": "lieu", "RESUME": "resume",
  "DUREE": "duree", "ALTITUDE MAX": "altitude", "ALTITUDE": "altitude", "DIFFICULTE": "difficulte",
};
const INFOS_TREK = [["duree", "Durée"], ["altitude", "Altitude max"], ["dplus", "D+"], ["dmoins", "D−"], ["difficulte", "Difficulté"]];
const sansAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Lit un fichier d'histoire :
//   TITRE : …, LIEU : …, RÉSUMÉ : …, DURÉE : …, ALTITUDE MAX : …, DIFFICULTÉ : …  (en tête, facultatifs)
//   puis le récit ; une ligne qui commence par ## est un sous-titre.
// Sans ligne TITRE, la 1re ligne du fichier sert de titre (ancien format).
function lireHistoire(fichier) {
  const lignes = fs.readFileSync(fichier, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim().split("\n");
  const infos = {};
  while (lignes.length) {
    const m = lignes[0].match(/^\s*([^:]{2,20}?)\s*:\s*(.*)$/);
    const champ = m && CHAMPS[sansAccents(m[1]).toUpperCase()];
    if (!champ) break;
    if (m[2].trim()) infos[champ] = m[2].trim();
    lignes.shift();
  }
  if (!infos.titre) infos.titre = lignes.shift().trim();
  return { ...infos, ...analyserRecit(lignes.join("\n")) };
}

// Découpe un récit en paragraphes et sous-titres (lignes qui commencent par ##).
function analyserRecit(texte) {
  const blocs = [];
  for (const bloc of texte.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/)) {
    const suite = bloc.trim().split("\n");
    while (suite.length && /^##/.test(suite[0].trim())) {
      blocs.push({ type: "sous-titre", texte: suite.shift().trim().replace(/^#+\s*/, "") });
    }
    if (suite.length && suite.join("").trim()) blocs.push({ type: "paragraphe", texte: suite.join("\n").trim() });
  }
  return { blocs, paragraphes: blocs.filter((b) => b.type === "paragraphe").map((b) => b.texte) };
}

// Lit une histoire écrite avec Pages CMS : en-tête YAML entre deux lignes ---, puis le récit.
function lireHistoireCms(fichier) {
  const brut = fs.readFileSync(fichier, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = brut.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const infos = (m && YAML.parse(m[1])) || {};
  const texte = String(m ? m[2] : brut);
  const enTexte = (v) => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim());
  const recit = analyserRecit(texte);

  // Étapes du carnet de route : titre, infos facultatives, texte et photos légendées.
  const etapes = [].concat(infos.etapes || []).filter((e) => e && typeof e === "object").map((e) => ({
    chapitre: enTexte(e.chapitre),
    titre: enTexte(e.titre),
    jour: enTexte(e.jour),
    temps: enTexte(e.temps),
    altitude: enTexte(e.altitude),
    dplus: enTexte(e.denivele_positif),
    dmoins: enTexte(e.denivele_negatif),
    ...analyserRecit(enTexte(e.texte) || ""),
    photos: [].concat(e.photos || [])
      .map((p) => (typeof p === "string" ? { image: p } : p || {}))
      .map((p) => ({ image: enTexte(p.image), legende: enTexte(p.legende) }))
      .filter((p) => p.image),
  }));

  return {
    titre: enTexte(infos.titre) || path.basename(fichier, ".md"),
    date: enTexte(infos.date),
    lieu: enTexte(infos.lieu),
    resume: enTexte(infos.resume),
    duree: enTexte(infos.duree),
    altitude: enTexte(infos.altitude),
    difficulte: enTexte(infos.difficulte),
    couverture: enTexte(infos.couverture),
    galerie: [].concat(infos.galerie || []).map(enTexte).filter(Boolean),
    blocs: recit.blocs,
    etapes,
    // Pour le résumé automatique : le récit d'introduction, sinon le texte des étapes.
    paragraphes: [...recit.paragraphes, ...etapes.flatMap((e) => e.paragraphes)],
  };
}

// Additionne des dénivelés écrits librement (« 650 m », « +650 », « 1 200 »).
// Renvoie undefined si une étape n'a pas de valeur : un total partiel serait trompeur.
function totalDenivele(valeurs) {
  if (!valeurs.length || valeurs.some((v) => !v)) return undefined;
  const nombres = valeurs.map((v) => parseInt(v.replace(/[^\d]/g, ""), 10));
  if (nombres.some(isNaN)) return undefined;
  return nombres.reduce((a, b) => a + b, 0).toLocaleString("fr-FR").replace(/ /g, " ") + " m";
}

// Une photo cliquable (ouverte dans la visionneuse), avec sa légende éventuelle.
function figurePhoto(fichier, legende) {
  return `<figure>
        <a class="photo" href="${encodeURI(fichier)}"${legende ? ` data-legende="${echapper(legende)}"` : ""}><img src="${encodeURI(fichier)}" alt="${echapper(legende || "")}" loading="lazy"></a>
        ${legende ? `<figcaption>${echapper(legende)}</figcaption>` : ""}
      </figure>`;
}

// Regroupe les étapes consécutives d'un même chapitre (champ « Chapitre » facultatif).
function parChapitre(etapes) {
  const groupes = [];
  etapes.forEach((e, i) => {
    const dernier = groupes[groupes.length - 1];
    if (!dernier || (e.chapitre && e.chapitre !== dernier.titre)) {
      groupes.push({ titre: e.chapitre, etapes: [] });
    }
    groupes[groupes.length - 1].etapes.push({ ...e, numero: i + 1 });
  });
  return groupes;
}

// Sommaire cliquable, utile pour les longues histoires (4 étapes ou plus).
function sommaire(etapes) {
  if (etapes.length < 4) return "";
  const lien = (e) => `<li><a href="#etape-${e.numero}"><span>${e.numero}</span> ${echapper(e.titre || "Étape " + e.numero)}</a></li>`;
  const groupes = parChapitre(etapes);
  return `<nav class="sommaire" aria-label="Sommaire">
    <p class="sommaire__titre">Au fil du voyage</p>
    ${groupes.map((g, i) => g.titre
      ? `<div class="sommaire__chapitre"><a class="sommaire__nom" href="#chapitre-${i + 1}">${echapper(g.titre)}</a><ol>${g.etapes.map(lien).join("")}</ol></div>`
      : `<ol>${g.etapes.map(lien).join("")}</ol>`).join("\n    ")}
  </nav>`;
}

// Le carnet de route : les étapes reliées par un fil, chacune avec ses photos,
// regroupées en chapitres si le champ « Chapitre » est utilisé.
function carnetDeRoute(etapes) {
  if (!etapes.length) return "";
  return parChapitre(etapes).map((g, i) => `
  ${g.titre ? `<h2 class="chapitre" id="chapitre-${i + 1}">${echapper(g.titre)}</h2>` : ""}
  <ol class="carnet" start="${g.etapes[0].numero}">${g.etapes.map(etapeHtml).join("")}
  </ol>`).join("");
}

function etapeHtml(e) {
  const infos = [["Temps de marche", e.temps], ["Altitude max", e.altitude], ["D+", e.dplus], ["D−", e.dmoins]]
    .filter(([, v]) => v);
  return `
    <li class="etape" id="etape-${e.numero}">
      <span class="etape__repere" aria-hidden="true">${e.numero}</span>
      ${e.jour ? `<p class="etape__jour">${echapper(e.jour)}</p>` : ""}
      ${e.titre ? `<h2 class="etape__titre">${echapper(e.titre)}</h2>` : ""}
      ${infos.length ? `<ul class="etiquettes">${infos.map(([l, v]) =>
        `<li><span>${l}</span> ${echapper(v)}</li>`).join("")}</ul>` : ""}
      ${e.blocs.map((b) => b.type === "sous-titre"
        ? `<h3 class="sous-titre">${enHtml(b.texte)}</h3>`
        : `<p>${enHtml(b.texte)}</p>`).join("\n      ")}
      ${e.photos.length ? `<div class="photos photos--${Math.min(e.photos.length, 5)}">
      ${e.photos.map((p) => figurePhoto(p.fichier, p.legende)).join("\n      ")}
      </div>` : ""}
    </li>`;
}

// Retrouve une photo choisie dans Pages CMS (ex. « photos/col.jpg ») dans contenu/photos.
// Tolère un changement d'extension (une photo .png allégée devient .jpg).
function trouverPhotoCms(chemin) {
  const nom = path.basename(chemin);
  const exacte = path.join(PHOTOS_CMS, nom);
  if (fs.existsSync(exacte)) return exacte;
  const base = nom.replace(/\.[^.]+$/, "").toLowerCase();
  const autre = fs.existsSync(PHOTOS_CMS) && fs.readdirSync(PHOTOS_CMS)
    .find((f) => f.replace(/\.[^.]+$/, "").toLowerCase() === base && IMAGES.includes(path.extname(f).toLowerCase()));
  return autre ? path.join(PHOTOS_CMS, autre) : null;
}

// Mise en forme minimale : **gras**, *italique*, retour à la ligne simple.
function enHtml(paragraphe) {
  return echapper(paragraphe)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

function resume(paragraphes, max = 220) {
  const texte = (typeof paragraphes === "string" ? paragraphes : paragraphes[0] || "")
    .replace(/\*/g, "").replace(/\s+/g, " ");
  if (texte.length <= max) return texte;
  return texte.slice(0, texte.lastIndexOf(" ", max)) + "…";
}

// Petites étiquettes « Durée · 8 jours », « Altitude max · 5 090 m »…
function etiquettes(h) {
  const presentes = INFOS_TREK.filter(([cle]) => h[cle]);
  if (!presentes.length) return "";
  return `<ul class="etiquettes">${presentes.map(([cle, libelle]) =>
    `<li><span>${libelle}</span> ${echapper(h[cle])}</li>`).join("")}</ul>`;
}

function slug(nom) {
  return nom.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function listerImages(dossier) {
  const fichiers = fs.readdirSync(dossier);
  for (const f of fichiers) {
    if (/\.(heic|heif)$/i.test(f)) {
      avertissements.push(`« ${f} » ignorée : le format HEIC (iPhone) n'est pas pris en charge, enregistrez-la en JPG.`);
    }
  }
  return fichiers
    .filter((f) => IMAGES.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}

function dateLisible(d) {
  return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`;
}

// racine : chemin relatif vers la racine du site ("", "../", "../../").
// chemin : adresse de la page relative au site (« », « contact/ », « histoires/x/ »).
// partage : image d'aperçu (relative au site), utilisée par Google, WhatsApp, Facebook...
function page({ titre, blog, racine, corps, chemin, description, partage, type = "website" }) {
  const url = ADRESSE_SITE + chemin;
  pagesDuSite.push(url);
  return fs.readFileSync(path.join(MODELE, "page.html"), "utf8")
    .replaceAll("{{titre}}", echapper(titre))
    .replaceAll("{{blog}}", echapper(blog))
    .replaceAll("{{description}}", echapper(description || ""))
    .replaceAll("{{url}}", url)
    .replaceAll("{{image}}", partage ? ADRESSE_SITE + partage : "")
    .replaceAll("{{type}}", type)
    .replaceAll("{{racine}}", racine)
    .replace("{{corps}}", () => corps);
}

// Image d'aperçu au format attendu par les réseaux sociaux : JPEG 1200 × 630.
async function imagePartage(source, cible) {
  if (!source || !fs.existsSync(source)) return null;
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  await sharp(source).rotate().resize(1200, 630, { fit: "cover" }).jpeg({ quality: 80, mozjpeg: true }).toFile(cible);
  return path.relative(SORTIE, cible).split(path.sep).join("/");
}

// Plan du site pour les moteurs de recherche.
function planDuSite() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...pagesDuSite].sort((a, b) => a.length - b.length).map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(SORTIE, "sitemap.xml"), xml);
  fs.writeFileSync(path.join(SORTIE, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ADRESSE_SITE}sitemap.xml\n`);
}

// Rend cliquables les e-mails, liens web et numéros de téléphone / WhatsApp.
function lienContact(libelle, valeur) {
  const v = echapper(valeur);
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(valeur)) return `<a href="mailto:${v}">${v}</a>`;
  if (/^(https?:\/\/|www\.)/i.test(valeur)) {
    const url = /^www\./i.test(valeur) ? "https://" + valeur : valeur;
    return `<a href="${echapper(url)}" target="_blank" rel="noopener">${v.replace(/^https?:\/\//i, "")}</a>`;
  }
  const chiffres = valeur.replace(/[^\d+]/g, "");
  if (/^\+?\d{6,}$/.test(chiffres)) {
    const whatsapp = `https://wa.me/${chiffres.replace("+", "")}`;
    // « Téléphone / WhatsApp » : le numéro appelle, et un bouton ouvre WhatsApp.
    if (/whatsapp/i.test(libelle) && /t[ée]l|phone|portable|mobile/i.test(libelle)) {
      return `<a href="tel:${chiffres}">${v}</a> <a class="whatsapp" href="${whatsapp}" target="_blank" rel="noopener">WhatsApp</a>`;
    }
    if (/whatsapp/i.test(libelle)) return `<a href="${whatsapp}" target="_blank" rel="noopener">${v}</a>`;
    return `<a href="tel:${chiffres}">${v}</a>`;
  }
  return v;
}

// contact.txt : 1re ligne = titre, puis des paragraphes libres et/ou des lignes « Libellé : valeur ».
function contactEnHtml(paragraphes) {
  const ligneInfo = /^([^:\n]{1,30}?)\s*:\s+(.+)$/;
  return paragraphes.map((bloc) => {
    const lignes = bloc.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lignes.every((l) => ligneInfo.test(l))) return `<p>${enHtml(bloc)}</p>`;
    return `<dl class="coordonnees">${lignes.map((l) => {
      const [, libelle, valeur] = l.match(ligneInfo);
      return `<div><dt>${echapper(libelle)}</dt><dd>${lienContact(libelle, valeur.trim())}</dd></div>`;
    }).join("")}</dl>`;
  }).join("\n    ");
}

// --- Photos --------------------------------------------------------------

// Nom de la photo une fois publiée (les SVG restent tels quels).
const nomPublie = (f) => /\.svg$/i.test(f) ? f : f.replace(/\.[^.]+$/, ".webp");

// Réduit une photo pour le site. Le résultat est mis en cache pour ne pas
// refaire le travail à chaque génération.
async function publierPhoto(source, cible, largeur) {
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  if (/\.svg$/i.test(source)) return fs.copyFileSync(source, cible);

  const { size, mtimeMs } = fs.statSync(source);
  const cle = slug(path.relative(CONTENU, source)) + `-${size}-${Math.round(mtimeMs)}-${largeur}.webp`;
  const enCache = path.join(CACHE, cle);
  if (!fs.existsSync(enCache)) {
    fs.mkdirSync(CACHE, { recursive: true });
    await sharp(source).rotate()
      .resize({ width: largeur, height: largeur, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 }).toFile(enCache);
  }
  fs.copyFileSync(enCache, cible);
}

// --alleger : remplace les grosses photos de "contenu" par une version légère.
async function allegerContenu(dossier) {
  for (const nom of fs.readdirSync(dossier)) {
    const chemin = path.join(dossier, nom);
    if (fs.statSync(chemin).isDirectory()) { await allegerContenu(chemin); continue; }
    if (!/\.(jpe?g|png|webp|tiff?)$/i.test(nom)) continue;

    const { size } = fs.statSync(chemin);
    const { width = 0, height = 0 } = await sharp(chemin).metadata();
    if (size <= POIDS_MAX_CONTENU && Math.max(width, height) <= LARGEUR_ALLEGEE) continue;

    const original = path.join(ORIGINAUX, path.relative(CONTENU, chemin));
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.renameSync(chemin, original);
    const allegee = chemin.replace(/\.[^.]+$/, ".jpg");
    await sharp(original).rotate()
      .resize({ width: LARGEUR_ALLEGEE, height: LARGEUR_ALLEGEE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(allegee);
    const avant = (size / 1024 / 1024).toFixed(1);
    const apres = (fs.statSync(allegee).size / 1024).toFixed(0);
    console.log(`Photo allégée : ${path.relative(CONTENU, allegee)} (${avant} Mo → ${apres} Ko)`);
  }
}

// --- Construction --------------------------------------------------------

async function construire() {
  if (process.argv.includes("--alleger")) await allegerContenu(CONTENU);

  // On vide le dossier sans le supprimer : Windows refuse de supprimer un
  // dossier ouvert (par exemple dans l'Explorateur).
  fs.mkdirSync(SORTIE, { recursive: true });
  for (const f of fs.readdirSync(SORTIE)) {
    try {
      fs.rmSync(path.join(SORTIE, f), { recursive: true, force: true });
    } catch {
      avertissements.push(`« site\\${f} » n'a pas pu être nettoyé (dossier ouvert ailleurs ?).`);
    }
  }
  fs.copyFileSync(path.join(MODELE, "style.css"), path.join(SORTIE, "style.css"));

  // Accueil
  const dossierAccueil = path.join(CONTENU, "accueil");
  const fichierIntro = fs.readdirSync(dossierAccueil).find((f) => /\.txt$/i.test(f) && !/^contact/i.test(f));
  const intro = lireTexte(path.join(dossierAccueil, fichierIntro));
  const imageEntete = listerImages(dossierAccueil)[0];
  const enteteHtml = imageEntete && "entete" + path.extname(nomPublie(imageEntete));
  if (imageEntete) await publierPhoto(path.join(dossierAccueil, imageEntete), path.join(SORTIE, enteteHtml), LARGEUR_ENTETE);
  const partageAccueil = imageEntete ? await imagePartage(path.join(SORTIE, enteteHtml), path.join(SORTIE, "partage.jpg")) : null;

  // Histoires
  const dossierHistoires = path.join(CONTENU, "histoires");
  const histoires = [];

  const idsPris = new Set();
  const idUnique = (base) => {
    let id = base || "histoire", n = 2;
    while (idsPris.has(id)) id = `${base}-${n++}`;
    idsPris.add(id);
    return id;
  };

  for (const nom of fs.readdirSync(dossierHistoires)) {
    const dossier = path.join(dossierHistoires, nom);

    // Histoire écrite avec Pages CMS : un fichier .md, photos dans contenu/photos.
    if (/\.md$/i.test(nom) && fs.statSync(dossier).isFile()) {
      const texte = lireHistoireCms(dossier);
      const d = (texte.date || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
      const date = d ? new Date(+d[1], +d[2] - 1, +d[3]) : fs.statSync(dossier).mtime;
      const id = idUnique(slug(texte.titre));
      const cible = path.join(SORTIE, "histoires", id);

      const publier = async (chemin) => {
        const source = trouverPhotoCms(chemin);
        if (!source) {
          avertissements.push(`« ${texte.titre} » : photo introuvable « ${chemin} ».`);
          return null;
        }
        const nomFinal = nomPublie(path.basename(source));
        await publierPhoto(source, path.join(cible, nomFinal), LARGEUR_SITE);
        return nomFinal;
      };
      const couverture = texte.couverture ? await publier(texte.couverture) : null;
      const dansEtapes = new Set();
      for (const e of texte.etapes) {
        for (const p of e.photos) p.fichier = await publier(p.image);
        e.photos = e.photos.filter((p) => p.fichier);
        e.photos.forEach((p) => dansEtapes.add(p.fichier));
      }
      const autres = [];
      for (const p of texte.galerie) {
        const f = await publier(p);
        if (f && f !== couverture && !dansEtapes.has(f) && !autres.includes(f)) autres.push(f);
      }
      // Dénivelés totaux, calculés à partir des étapes.
      texte.dplus = totalDenivele(texte.etapes.map((e) => e.dplus));
      texte.dmoins = totalDenivele(texte.etapes.map((e) => e.dmoins));
      fs.mkdirSync(cible, { recursive: true });
      histoires.push({ ...texte, id, date, couverture, autres });
      continue;
    }

    if (!fs.statSync(dossier).isDirectory()) continue;

    const fichierTexte = fs.readdirSync(dossier).find((f) => f.toLowerCase().endsWith(".txt"));
    if (!fichierTexte) {
      avertissements.push(`« ${nom} » ignoré : aucun fichier texte (.txt) dedans.`);
      continue;
    }

    const texte = lireHistoire(path.join(dossier, fichierTexte));
    const images = listerImages(dossier);
    const couverture = images.find((f) => /^couverture\./i.test(f)) || images[0];
    const autres = images.filter((f) => f !== couverture);

    // Date : début du nom de dossier (AAAA-MM-JJ), sinon date du fichier texte.
    const m = nom.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = m ? new Date(+m[1], +m[2] - 1, +m[3]) : fs.statSync(path.join(dossier, fichierTexte)).mtime;

    const id = idUnique(slug(nom.replace(/^\d{4}-\d{2}-\d{2}\s*/, "")) || slug(nom));
    const cible = path.join(SORTIE, "histoires", id);
    fs.mkdirSync(cible, { recursive: true });
    for (const img of images) {
      await publierPhoto(path.join(dossier, img), path.join(cible, nomPublie(img)), LARGEUR_SITE);
    }

    histoires.push({
      ...texte, id, date,
      couverture: couverture && nomPublie(couverture),
      autres: autres.map(nomPublie),
    });
  }

  histoires.sort((a, b) => b.date - a.date);

  // Pages des histoires
  for (const h of histoires) {
    const galerie = h.autres.length
      ? `<div class="galerie">${h.autres.map((f) =>
          `<a class="photo" href="${encodeURI(f)}"><img src="${encodeURI(f)}" alt="" loading="lazy"></a>`).join("")}</div>`
      : "";
    const corps = `
<header class="bandeau bandeau--histoire">
  ${h.couverture ? `<img class="bandeau__image" src="${encodeURI(h.couverture)}" alt="${echapper(h.titre)}">` : ""}
  <div class="bandeau__voile"></div>
  <div class="bandeau__texte">
    <a class="retour" href="../../index.html">← ${echapper(intro.titre)}</a>
    <h1>${echapper(h.titre)}</h1>
    <p class="date">${dateLisible(h.date)}${h.lieu ? ` <span class="lieu">· ${echapper(h.lieu)}</span>` : ""}</p>
  </div>
</header>
<div class="drapeaux" aria-hidden="true"></div>
<main class="contenu">
  <article class="recit">
    ${etiquettes(h)}
    ${h.blocs.map((b) => b.type === "sous-titre"
      ? `<h2 class="sous-titre">${enHtml(b.texte)}</h2>`
      : `<p>${enHtml(b.texte)}</p>`).join("\n    ")}
  </article>
  ${sommaire(h.etapes || [])}
  ${carnetDeRoute(h.etapes || [])}
  ${galerie}
  <p class="fin"><a class="bouton" href="../../index.html">← Toutes les histoires</a></p>
</main>`;
    const dossierHistoire = path.join(SORTIE, "histoires", h.id);
    const partage = h.couverture
      ? await imagePartage(path.join(dossierHistoire, h.couverture), path.join(dossierHistoire, "partage.jpg"))
      : partageAccueil;
    fs.writeFileSync(path.join(dossierHistoire, "index.html"), page({
      titre: `${h.titre} · ${intro.titre}`, blog: intro.titre, racine: "../../", corps,
      chemin: `histoires/${h.id}/`, description: resume(h.resume || h.paragraphes, 160), partage, type: "article",
    }));
  }

  // Page d'accueil
  const cartes = histoires.map((h) => `
    <a class="carte" href="histoires/${h.id}/index.html">
      <div class="carte__image">${h.couverture
        ? `<img src="histoires/${h.id}/${encodeURI(h.couverture)}" alt="${echapper(h.titre)}" loading="lazy">` : ""}</div>
      <div class="carte__texte">
        <p class="date">${dateLisible(h.date)}</p>
        <h3>${echapper(h.titre)}</h3>
        ${h.lieu ? `<p class="lieu">${echapper(h.lieu)}</p>` : ""}
        <p>${echapper(resume(h.resume || h.paragraphes))}</p>
        ${etiquettes(h)}
        <span class="lire">Lire l'histoire →</span>
      </div>
    </a>`).join("");

  const corpsAccueil = `
<header class="bandeau bandeau--fixe">
  ${imageEntete ? `<img class="bandeau__image" src="${enteteHtml}" alt="${echapper(intro.titre)}">` : ""}
  <div class="bandeau__voile"></div>
  <div class="bandeau__texte"><h1>${echapper(intro.titre)}</h1></div>
</header>
<main class="contenu contenu--sur-bandeau">
  <div class="drapeaux" aria-hidden="true"></div>
  <section class="intro">
    ${intro.paragraphes.map((p) => `<p>${enHtml(p)}</p>`).join("\n    ")}
  </section>
  <section>
    <h2 id="recits">Récits de trek</h2>
    <div class="cartes">${cartes || "<p>Aucune histoire pour le moment.</p>"}
    </div>
  </section>
</main>`;
  fs.writeFileSync(path.join(SORTIE, "index.html"), page({
    titre: intro.titre, blog: intro.titre, racine: "", corps: corpsAccueil,
    chemin: "", description: resume(intro.paragraphes, 160), partage: partageAccueil,
  }));

  // Page de contact
  const fichierContact = fs.readdirSync(dossierAccueil).find((f) => /^contact.*\.txt$/i.test(f));
  const contact = fichierContact
    ? lireTexte(path.join(dossierAccueil, fichierContact))
    : { titre: "Contact", paragraphes: [] };
  if (!fichierContact) avertissements.push("Pas de fichier contact.txt dans contenu\\accueil : la page Contact est vide.");
  const corpsContact = `
<header class="bandeau bandeau--court">
  ${imageEntete ? `<img class="bandeau__image" src="../${enteteHtml}" alt="">` : ""}
  <div class="bandeau__voile"></div>
  <div class="bandeau__texte"><h1>${echapper(contact.titre)}</h1></div>
</header>
<div class="drapeaux" aria-hidden="true"></div>
<main class="contenu">
  <section class="recit contact">
    ${contactEnHtml(contact.paragraphes)}
  </section>
  <p class="fin"><a class="bouton" href="../index.html">← Retour à l'accueil</a></p>
</main>`;
  fs.mkdirSync(path.join(SORTIE, "contact"), { recursive: true });
  fs.writeFileSync(path.join(SORTIE, "contact", "index.html"),
    page({
      titre: `${contact.titre} · ${intro.titre}`, blog: intro.titre, racine: "../", corps: corpsContact,
      chemin: "contact/", partage: partageAccueil,
      // Description : le texte libre de la page, sans les lignes « Libellé : valeur ».
      description: resume(contact.paragraphes.filter((p) => !/^[^:\n]{1,30}?\s*:\s+/m.test(p)), 160),
    }));

  planDuSite();
  // Fichiers à placer tels quels à la racine du site (ex. vérification Google Search Console).
  if (fs.existsSync(RACINE_PUBLIQUE)) {
    for (const f of fs.readdirSync(RACINE_PUBLIQUE)) fs.copyFileSync(path.join(RACINE_PUBLIQUE, f), path.join(SORTIE, f));
  }

  console.log(`Site généré : ${histoires.length} histoire(s).`);
  for (const a of avertissements) console.log("Attention : " + a);

  if (process.argv.includes("--verifier")) await verifierOrthographe(intro, contact, histoires);
}

// --verifier : relit tous les textes et produit le rapport « orthographe.html ».
async function verifierOrthographe(intro, contact, histoires) {
  const { verifier, rapport } = require("./orthographe");
  const RAPPORT = path.join(RACINE, "orthographe.html");
  const ligneInfo = /^([^:\n]{1,30}?)\s*:\s+(.+)$/;
  const textes = [
    { nom: "Accueil (introduction)", texte: [intro.titre, ...intro.paragraphes].join("\n\n") },
    { nom: "Page Contact", texte: [contact.titre, ...contact.paragraphes.filter((p) =>
        !p.split("\n").every((l) => ligneInfo.test(l.trim())))].join("\n\n") },
    ...histoires.map((h) => ({
      nom: h.titre,
      texte: [h.titre, h.lieu, h.resume, h.duree, h.difficulte,
        ...h.blocs.map((b) => (b.type === "sous-titre" ? "## " : "") + b.texte),
        ...(h.etapes || []).flatMap((e) => [e.chapitre, e.jour, e.titre && "## " + e.titre,
          ...e.blocs.map((b) => (b.type === "sous-titre" ? "## " : "") + b.texte),
          ...e.photos.map((p) => p.legende && (/[.!?…]$/.test(p.legende) ? p.legende : p.legende + "."))]),
      ].filter(Boolean).join("\n\n"),
    })),
  ];

  console.log("Vérification de l'orthographe...");
  const resultat = await verifier(textes, {
    motsConnus: path.join(CONTENU, "mots-connus.txt"),
    fichierCache: path.join(CACHE, "orthographe.json"),
  });
  const total = rapport(resultat, RAPPORT);
  if (!resultat.enLigne) console.log("(Pas de connexion : orthographe seulement, sans la grammaire.)");
  if (total) {
    console.log(`Orthographe : ${total} remarque(s), voir le rapport qui s'ouvre.`);
  } else {
    console.log("Orthographe : aucune faute détectée.");
    fs.rmSync(RAPPORT, { force: true });
  }
}

construire().catch((e) => {
  console.error("Erreur : " + e.message);
  process.exit(1);
});
