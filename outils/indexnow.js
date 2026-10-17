// Prévient les moteurs de recherche (Bing, Yandex, Seznam, Naver...) qu'il y a
// du nouveau sur le site, grâce au protocole ouvert IndexNow. Aucun compte requis.
//
// Lancé par la publication automatique, une fois le site en ligne.
// La clé est le fichier contenu/racine/<clé>.txt, publié à la racine du site.
// Envoie toutes les pages du plan du site (sitemap.xml).

const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..");
const ADRESSE_SITE = require("../package.json").homepage.replace(/\/?$/, "/");

async function prevenir() {
  const dossierCle = path.join(RACINE, "contenu", "racine");
  const fichierCle = fs.existsSync(dossierCle) && fs.readdirSync(dossierCle).find((f) => /^[a-f0-9]{32}\.txt$/.test(f));
  if (!fichierCle) return console.log("IndexNow : pas de clé, rien à faire.");
  const cle = fichierCle.replace(".txt", "");

  const plan = fs.readFileSync(path.join(RACINE, "site", "sitemap.xml"), "utf8");
  const pages = [...plan.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  const reponse = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(ADRESSE_SITE).host,
      key: cle,
      keyLocation: ADRESSE_SITE + fichierCle,
      urlList: pages,
    }),
    signal: AbortSignal.timeout(20000),
  });

  // 200 : reçu ; 202 : reçu, clé en cours de vérification (normal au premier envoi).
  const explications = { 200: "pages transmises", 202: "pages transmises (clé en cours de vérification)",
    400: "requête invalide", 403: "clé refusée", 422: "adresses refusées", 429: "trop d'envois, réessayer plus tard" };
  console.log(`IndexNow : ${reponse.status} ${explications[reponse.status] || ""} — ${pages.length} page(s).`);
  if (reponse.status >= 400) process.exitCode = 1;
}

prevenir().catch((e) => {
  console.log("IndexNow : envoi impossible (" + e.message + ").");
  process.exitCode = 1;
});
