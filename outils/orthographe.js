// Vérification orthographique et grammaticale des textes du blog.
//
// - En ligne : LanguageTool (orthographe + grammaire), avec un cache pour ne
//   renvoyer que les textes modifiés.
// - Hors connexion : dictionnaire Hunspell français (orthographe seulement).
// - Les mots de contenu/mots-connus.txt (noms de lieux, mots ladakhis...) ne
//   sont jamais signalés.
// Rien n'est corrigé automatiquement : un rapport HTML liste les remarques.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://api.languagetool.org/v2/check";
const CATEGORIES_IGNOREES = "REPETITIONS_STYLE";
const PAUSE_ENTRE_REQUETES = 3100;   // l'API gratuite accepte 20 requêtes par minute
const TAILLE_MAX_REQUETE = 18000;    // et 20 000 caractères par requête

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const normaliser = (mot) => mot.replace(/’/g, "'").toLowerCase();

function lireMotsConnus(fichier) {
  if (!fs.existsSync(fichier)) return new Set();
  return new Set(fs.readFileSync(fichier, "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(normaliser));
}

// Retire la mise en forme (##, **, *) et isole les sous-titres en paragraphes.
function texteBrut(texte) {
  return texte.replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*#+[ \t]*(.*)$/gm, "$1\n")
    .replace(/\*+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Découpe un long texte en morceaux acceptés par l'API, aux fins de paragraphe.
function decouper(texte) {
  const morceaux = [];
  let courant = "";
  for (const p of texte.split("\n\n")) {
    if (courant && courant.length + p.length + 2 > TAILLE_MAX_REQUETE) {
      morceaux.push(courant);
      courant = "";
    }
    courant += (courant ? "\n\n" : "") + p;
  }
  if (courant) morceaux.push(courant);
  return morceaux;
}

async function interrogerLanguageTool(texte) {
  const remarques = [];
  let decalage = 0;
  for (const morceau of decouper(texte)) {
    const reponse = await fetch(API, {
      method: "POST",
      body: new URLSearchParams({ text: morceau, language: "fr", disabledCategories: CATEGORIES_IGNOREES }),
      signal: AbortSignal.timeout(20000),
    });
    if (!reponse.ok) throw new Error(`LanguageTool a répondu ${reponse.status}`);
    const { matches } = await reponse.json();
    for (const m of matches) {
      remarques.push({
        debut: decalage + m.offset,
        longueur: m.length,
        message: m.message,
        suggestions: m.replacements.slice(0, 3).map((r) => r.value),
        orthographe: m.rule.issueType === "misspelling",
      });
    }
    decalage += morceau.length + 2;
  }
  return remarques;
}

// --- Hors connexion : Hunspell --------------------------------------------
let correcteurHunspell = null;
async function hunspell() {
  if (!correcteurHunspell) {
    const { default: dictionnaire } = await import("dictionary-fr");
    const { default: nspell } = await import("nspell");
    correcteurHunspell = nspell(dictionnaire);
  }
  return correcteurHunspell;
}

const ELISION = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu)'/i;

async function verifierHorsConnexion(texte) {
  const correcteur = await hunspell();
  const motCorrect = (mot) => correcteur.correct(mot) || correcteur.correct(mot.toLowerCase());
  const remarques = [];
  for (const m of texte.matchAll(/[\p{L}][\p{L}'’-]*[\p{L}]|\p{L}/gu)) {
    const brut = m[0].replace(/’/g, "'");
    const mot = brut.replace(ELISION, "");
    if (!mot || mot === mot.toUpperCase() && mot.length > 1) continue;   // sigles
    if (motCorrect(brut) || motCorrect(mot)) continue;
    if (mot.includes("-") && mot.split("-").every((p) => !p || motCorrect(p))) continue;
    remarques.push({
      debut: m.index,
      longueur: m[0].length,
      message: "Mot inconnu du dictionnaire.",
      suggestions: correcteur.suggest(mot).slice(0, 3),
      orthographe: true,
    });
  }
  return remarques;
}

// --- Vérification complète --------------------------------------------------
// textes : [{ nom, texte }]. Renvoie { resultats, enLigne }.
async function verifier(textes, { motsConnus, fichierCache }) {
  const connus = lireMotsConnus(motsConnus);
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(fichierCache, "utf8")); } catch {}
  let enLigne = true;
  let premiereRequete = true;
  const resultats = [];

  for (const { nom, texte: original } of textes) {
    const texte = texteBrut(original);
    if (!texte) continue;
    const cle = crypto.createHash("sha1").update(texte).digest("hex");
    let remarques = cache[cle];

    if (!remarques && enLigne) {
      try {
        if (!premiereRequete) await pause(PAUSE_ENTRE_REQUETES);
        premiereRequete = false;
        remarques = await interrogerLanguageTool(texte);
        cache[cle] = remarques;
      } catch {
        enLigne = false;   // pas de connexion : on passe au dictionnaire pour la suite
      }
    }
    if (!remarques) remarques = await verifierHorsConnexion(texte);

    const filtrees = remarques
      .map((r) => ({ ...r, mot: texte.substr(r.debut, r.longueur) }))
      .filter((r) => !(r.orthographe
        && (connus.has(normaliser(r.mot)) || connus.has(normaliser(r.mot).replace(ELISION, "")))));
    resultats.push({ nom, texte, remarques: filtrees });
  }

  fs.mkdirSync(path.dirname(fichierCache), { recursive: true });
  fs.writeFileSync(fichierCache, JSON.stringify(cache));
  return { resultats, enLigne };
}

// --- Rapport HTML ---------------------------------------------------------
const echapper = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function extrait(texte, debut, longueur) {
  const avant = texte.slice(Math.max(0, debut - 60), debut);
  const apres = texte.slice(debut + longueur, debut + longueur + 60);
  return `${debut > 60 ? "…" : ""}${echapper(avant).replace(/\n+/g, " ")}<mark>${echapper(texte.substr(debut, longueur))}</mark>${echapper(apres).replace(/\n+/g, " ")}${debut + longueur + 60 < texte.length ? "…" : ""}`;
}

function rapport({ resultats, enLigne }, fichier) {
  const total = resultats.reduce((n, r) => n + r.remarques.length, 0);
  const blocs = resultats.filter((r) => r.remarques.length).map((r) => `
  <section>
    <h2>${echapper(r.nom)} <span>${r.remarques.length} remarque${r.remarques.length > 1 ? "s" : ""}</span></h2>
    <ul>${r.remarques.map((m) => `
      <li>
        <p class="extrait">${extrait(r.texte, m.debut, m.longueur)}</p>
        <p class="message">${echapper(m.message)}${m.suggestions.length
          ? ` → <strong>${m.suggestions.map(echapper).join("</strong> ou <strong>")}</strong>` : ""}</p>
      </li>`).join("")}
    </ul>
  </section>`).join("");

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vérification orthographique</title>
<style>
  :root { --fond: #f6f0e4; --carte: #fffcf6; --texte: #2c241f; --discret: #7d6e60; --bordeaux: #7b1e2b; --vert: #2f8a57; --bordure: #e6dccb; }
  body { margin: 0; padding: 2rem 16px 4rem; background: var(--fond); color: var(--texte); font: 17px/1.6 system-ui, sans-serif; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin: 0 0 .3rem; }
  .info { color: var(--discret); margin: 0 0 2rem; }
  .bilan { padding: 1rem 1.25rem; border-radius: 8px; background: var(--carte); border-left: 5px solid var(--bordeaux); margin-bottom: 2rem; }
  .bilan.ok { border-left-color: var(--vert); }
  section { background: var(--carte); border: 1px solid var(--bordure); border-radius: 8px; padding: .5rem 1.25rem 1rem; margin-bottom: 1.25rem; }
  h2 { font-size: 1.2rem; display: flex; justify-content: space-between; gap: 1rem; }
  h2 span { color: var(--discret); font-size: .9rem; font-weight: 400; white-space: nowrap; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .7rem 0; border-top: 1px solid var(--bordure); }
  .extrait { margin: 0 0 .2rem; }
  mark { background: #f6d3d7; color: var(--bordeaux); font-weight: 600; padding: 0 .15rem; border-radius: 3px; }
  .message { margin: 0; color: var(--discret); font-size: .95rem; }
  .message strong { color: var(--vert); }
  .astuce { color: var(--discret); font-size: .95rem; }
</style></head>
<body><main>
  <h1>Vérification orthographique</h1>
  <p class="info">${enLigne
    ? "Vérifié avec LanguageTool : orthographe et grammaire."
    : "Pas de connexion Internet : vérification de l'orthographe seulement (dictionnaire). Relancez « Aperçu du site » une fois connecté pour vérifier aussi la grammaire."}</p>
  <div class="bilan${total ? "" : " ok"}">${total
    ? `<strong>${total} remarque${total > 1 ? "s" : ""}</strong> à regarder. Rien n'a été modifié : corrigez vos fichiers texte si besoin, puis relancez « Aperçu du site ».`
    : "<strong>Aucune faute détectée.</strong> Bravo !"}</div>
  ${blocs}
  <p class="astuce">Un nom de lieu ou un mot local est signalé à tort ? Ajoutez-le dans le fichier <code>contenu\\mots-connus.txt</code> (un mot par ligne) : il ne sera plus signalé.</p>
</main></body></html>`;
  fs.writeFileSync(fichier, html);
  return total;
}

module.exports = { verifier, rapport };
