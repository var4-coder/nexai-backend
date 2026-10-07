import fs from 'fs';
import path from 'path';
import { env } from '@/config/env';

/**
 * KIT NEXAI (Librairie v8) — formulaire (form.js + form.css), mouvement
 * (motion.js) et GSAP (gsap.min.js + ScrollTrigger.min.js).
 *
 * Ces fichiers sont INSÉRÉS PAR LE SYSTÈME, jamais recopiés par le codeur :
 *   · le codeur n'a pas à réécrire ~2 000 tokens de code déjà testé (coût,
 *     risque d'erreur de recopie) ;
 *   · les juges et le réparateur reçoivent la page SANS le kit (sansKit) :
 *     ils jugent le travail du codeur, pas notre code ;
 *   · GSAP est servi par NexAI (AI_RULES : « fichiers GSAP servis par NexAI,
 *     jamais un CDN tiers ») : depuis l'API pendant l'aperçu, depuis le site
 *     lui-même (/kit/…) une fois en ligne.
 *
 * Tout ce qui est inséré est encadré de repères, pour pouvoir le retirer et
 * le remettre sans jamais le dupliquer.
 */

export const KIT_DIR = path.join(process.cwd(), 'seed-data', 'kit');

/** Fichiers GSAP à publier avec le site (chemin publié → nom du fichier du kit). */
export const FICHIERS_GSAP = ['gsap.min.js', 'ScrollTrigger.min.js'] as const;

const cache = new Map<string, string>();

export function lireFichierKit(nom: string): string {
  const deja = cache.get(nom);
  if (deja !== undefined) return deja;
  try {
    const contenu = fs.readFileSync(path.join(KIT_DIR, nom), 'utf-8');
    cache.set(nom, contenu);
    return contenu;
  } catch (err) {
    console.warn(`[kit] Fichier du kit « ${nom} » illisible`, (err as Error).message);
    cache.set(nom, '');
    return '';
  }
}

const DEBUT_CSS = '<!--nexai-kit:css-->';
const FIN_CSS = '<!--/nexai-kit:css-->';
const DEBUT_JS = '<!--nexai-kit:js-->';
const FIN_JS = '<!--/nexai-kit:js-->';

function echapperScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

function retirerEntre(html: string, debut: string, fin: string): string {
  let sortie = html;
  for (let garde = 0; garde < 10; garde++) {
    const i = sortie.indexOf(debut);
    if (i === -1) break;
    const j = sortie.indexOf(fin, i);
    if (j === -1) {
      sortie = sortie.slice(0, i) + sortie.slice(i + debut.length);
      continue;
    }
    sortie = sortie.slice(0, i) + sortie.slice(j + fin.length);
  }
  return sortie;
}

/**
 * Copies du kit écrites par le codeur lui-même (la Librairie décrit le kit,
 * un modèle peut le recopier) : retirées, sinon le geste serait joué deux
 * fois et le formulaire défini deux fois. Repérées par leur contenu.
 */
function retirerCopiesDuKit(html: string): string {
  return html
    .replace(/<script\b(?![^>]*\bsrc=)[^>]*>(?:(?!<\/script>)[\s\S])*?NexaiForm\s*=\s*\{\s*mount\s*\}(?:(?!<\/script>)[\s\S])*?<\/script>\s*/gi, '')
    .replace(/<script\b(?![^>]*\bsrc=)[^>]*>(?:(?!<\/script>)[\s\S])*?getAttribute\(\s*['"]data-geste['"]\s*\)(?:(?!<\/script>)[\s\S])*?<\/script>\s*/gi, '');
}

/** Page SANS le kit inséré par le système (pour les juges, le réparateur, les modifications IA). */
export function sansKit(html: string): string {
  if (!html) return html;
  return retirerCopiesDuKit(retirerEntre(retirerEntre(html, DEBUT_CSS, FIN_CSS), DEBUT_JS, FIN_JS));
}

/** Valeur de `<html data-geste>` de la page (défaut : entree). */
export function gesteDeLaPage(html: string): string {
  const m = /<html\b[^>]*\bdata-geste\s*=\s*["']([^"']+)["']/i.exec(html);
  return m ? m[1].trim() : 'entree';
}

/** La page utilise-t-elle le formulaire NexAI (NexaiForm) ? */
export function utiliseFormulaire(html: string): boolean {
  return /NexaiForm\s*\.\s*mount/.test(html);
}

/** La page charge-t-elle GSAP (geste autre que « aucun ») ? */
export function utiliseGsap(html: string): boolean {
  return gesteDeLaPage(html) !== 'aucun';
}

/**
 * Insère le kit dans une page.
 *  · mode 'apercu'      : GSAP chargé depuis l'API NexAI (PUBLIC_API_BASE_URL/kit/…) ;
 *  · mode 'publication' : GSAP chargé depuis le site lui-même (/kit/…), les
 *    fichiers étant publiés avec le site (voir publication.service).
 * Idempotent : le kit déjà présent est d'abord retiré. Les balises GSAP que
 * le codeur aurait écrites lui-même (src relatif introuvable) sont retirées.
 */
export function avecKit(html: string, mode: 'apercu' | 'publication' = 'apercu'): string {
  if (!html || !/<\/head>/i.test(html)) return html;
  let page = sansKit(html).replace(
    /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:gsap|ScrollTrigger)[^"']*["'][^>]*>\s*<\/script>\s*/gi,
    ''
  );

  const base = mode === 'publication' ? '/kit' : `${env.PUBLIC_API_BASE_URL.replace(/\/$/, '')}/kit`;
  const geste = gesteDeLaPage(page);
  const formulaire = utiliseFormulaire(page);

  // CSS du formulaire AVANT les styles de la page : la page peut l'ajuster.
  if (formulaire) {
    const css = `${DEBUT_CSS}<style data-nexai-kit="form">${lireFichierKit('form.css')}</style>${FIN_CSS}`;
    const premierStyle = page.search(/<style\b/i);
    const finHead = page.search(/<\/head>/i);
    const position = premierStyle !== -1 && premierStyle < finHead ? premierStyle : finHead;
    page = page.slice(0, position) + css + '\n' + page.slice(position);
  }

  const scripts: string[] = [];
  if (geste !== 'aucun') {
    // Ordre imposé par kit/motion.js : GSAP et ScrollTrigger en defer, puis
    // motion.js EN LIGNE (il attend DOMContentLoaded, qui suit les scripts defer).
    scripts.push(`<script src="${base}/gsap.min.js" defer></script>`);
    scripts.push(`<script src="${base}/ScrollTrigger.min.js" defer></script>`);
    scripts.push(`<script data-nexai-kit="motion">${echapperScript(lireFichierKit('motion.js'))}</script>`);
  }
  if (formulaire) {
    // Définit seulement window.NexaiForm : sans risque dans <head>, prêt
    // avant l'appel NexaiForm.mount écrit par le codeur en fin de page.
    scripts.push(`<script data-nexai-kit="form">${echapperScript(lireFichierKit('form.js'))}</script>`);
  }
  if (scripts.length > 0) {
    // Remplacement par fonction : le code inséré peut contenir « $ ».
    const bloc = `${DEBUT_JS}\n${scripts.join('\n')}\n${FIN_JS}\n</head>`;
    page = page.replace(/<\/head>/i, () => bloc);
  }
  return page;
}
