import { callClaude, callGrok, type ClaudeModel, type GrokModel } from '@/services/ai-clients';
import { sansKit } from '@/services/kit.service';
import { runScan1 } from '@/services/scan.service';

/**
 * Réparateur NexAI — corrections CIBLÉES (décision du 03/10/2026, option 1A).
 *
 * Avant : le réparateur réécrivait toute la page (≈ 12 000 tokens de sortie
 * par passage). Maintenant il renvoie seulement les morceaux à changer
 * (« chercher » → « remplacer »), environ 7 fois moins de texte écrit : plus
 * rapide et moins cher, et rien d'autre dans la page ne peut bouger.
 *
 * Filet : si une correction ne s'applique pas proprement (extrait introuvable
 * ou présent plusieurs fois) ou si la page obtenue est cassée, on revient à
 * l'ancien mode « HTML complet » — un seul appel de plus, jamais davantage.
 *
 * Le modèle est choisi dans l'admin (rôle reparateur_code : Grok Build par
 * défaut, Sonnet 5.5 en alternance) et lu UNE fois au début de la génération
 * par l'appelant : un site garde le même réparateur du début à la fin.
 */

export interface ResultatReparation {
  /** Page réparée (sans kit), ou null si aucune réparation exploitable. */
  html: string | null;
  mode: 'cible' | 'complet' | null;
  /** Nombre de corrections ciblées appliquées. */
  appliquees: number;
}

interface CorrectionCiblee {
  chercher?: unknown;
  remplacer?: unknown;
}

const SYSTEME = 'Tu es le Réparateur NexAI. Tu réponds uniquement en JSON valide, sans texte autour.';

function consignesCommunes(famille?: string): string {
  return `Corrige UNIQUEMENT les erreurs signalées, en commençant par celles de gravité "veto".${
    famille
      ? `\nFamille imposée à ce site (seules couleurs, polices et déclaration <html> permises — ne jamais en changer) :\n${famille}\n`
      : ''
  }
Le kit NexAI (form.js, form.css, motion.js, GSAP) est inséré par le système : ne l'ajoute pas.
Chaque erreur cite le numéro de la règle de la Librairie NexAI qu'elle viole et la correction attendue (SOLUTION). Applique la correction_attendue de chaque erreur à la lettre : n'improvise pas une autre réparation. Ne touche à rien d'autre (textes, structure, identité visuelle).`;
}

function promptCible(html: string, erreurs: string, famille?: string): string {
  return `${consignesCommunes(famille)}

MODE CORRECTIONS CIBLÉES : ne renvoie PAS la page. Renvoie seulement les remplacements à faire.
- "chercher" : un extrait COPIÉ CARACTÈRE POUR CARACTÈRE du HTML actuel (espaces et guillemets compris), assez long pour n'apparaître qu'UNE SEULE fois dans la page (une ligne ou une règle CSS entière ; 400 caractères maximum).
- "remplacer" : le nouveau texte qui prend sa place (pour AJOUTER du CSS, cherche la dernière règle d'un bloc <style> et renvoie-la suivie des nouvelles règles).
- 15 corrections maximum. Si une erreur ne peut pas être corrigée, mets-la dans "non_applique".

Erreurs :
${erreurs}

HTML actuel :
${html}

Réponds en JSON strict :
{"corrections":[{"erreur":"M3","chercher":"…","remplacer":"…"}],"non_applique":[],"zone_impact":{"data_nexai_ids":[],"tokens_css_modifies":[]}}`;
}

function promptComplet(html: string, erreurs: string, famille?: string): string {
  return `${consignesCommunes(famille)}
Si une correction est impossible, dis-le dans "non_applique". Déclare ta zone d'impact (data-nexai-id modifiés + tokens CSS changés).

Erreurs :
${erreurs}

HTML actuel :
${html}

Réponds en JSON strict :
{"zone_impact":{"data_nexai_ids":[],"tokens_css_modifies":[]},"non_applique":[],"html_patch":"...html complet corrigé..."}`;
}

function parseJson<T>(raw: string): T | null {
  try {
    const nettoye = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(nettoye) as T;
  } catch {
    // Certains modèles entourent le JSON d'une phrase : on tente le premier objet.
    const debut = raw.indexOf('{');
    const fin = raw.lastIndexOf('}');
    if (debut >= 0 && fin > debut) {
      try {
        return JSON.parse(raw.slice(debut, fin + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function appeler(modele: string, prompt: string, maxTokens: number): Promise<string> {
  if (modele.startsWith('claude-')) {
    return callClaude(modele as ClaudeModel, SYSTEME, [{ role: 'user', content: prompt }], { maxTokens });
  }
  return callGrok(
    modele as GrokModel,
    [
      { role: 'system', content: SYSTEME },
      { role: 'user', content: prompt },
    ],
    { maxTokens, temperature: 0.2 }
  );
}

function echapperRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applique les remplacements. Échec dès qu'un extrait est introuvable ou
 * ambigu (présent plusieurs fois) : on ne devine jamais l'endroit.
 * Tolérance unique : différences d'espaces (retours à la ligne, indentation).
 */
export function appliquerCorrections(html: string, corrections: CorrectionCiblee[]): { html: string; ok: boolean; appliquees: number } {
  let courant = html;
  let appliquees = 0;
  for (const c of corrections) {
    const chercher = typeof c.chercher === 'string' ? c.chercher : '';
    const remplacer = typeof c.remplacer === 'string' ? c.remplacer : null;
    if (!chercher.trim() || remplacer === null) return { html, ok: false, appliquees: 0 };
    const premier = courant.indexOf(chercher);
    if (premier >= 0) {
      if (courant.indexOf(chercher, premier + chercher.length) >= 0) return { html, ok: false, appliquees: 0 };
      courant = courant.slice(0, premier) + remplacer + courant.slice(premier + chercher.length);
      appliquees++;
      continue;
    }
    // Tolérance aux espaces : chaque suite d'espaces de l'extrait accepte n'importe quelle suite d'espaces.
    const motif = chercher
      .trim()
      .split(/\s+/)
      .map(echapperRegex)
      .join('\\s+');
    const re = new RegExp(motif, 'g');
    const trouves = courant.match(re);
    if (!trouves || trouves.length !== 1) return { html, ok: false, appliquees: 0 };
    courant = courant.replace(re, () => remplacer);
    appliquees++;
  }
  return { html: courant, ok: appliquees > 0, appliquees };
}

/**
 * Répare une page. `erreurs` = défauts AVEC leurs solutions (JSON ou texte).
 * Ne lève jamais d'erreur : une panne du réparateur laisse la page telle quelle.
 */
export async function reparerPage(params: {
  modele: string;
  html: string;
  erreurs: string;
  famille?: string;
}): Promise<ResultatReparation> {
  const page = sansKit(params.html).slice(0, 120000);

  // 1. Corrections ciblées.
  try {
    const brut = await appeler(params.modele, promptCible(page, params.erreurs, params.famille), 8000);
    const rep = parseJson<{ corrections?: CorrectionCiblee[] }>(brut);
    const corrections = Array.isArray(rep?.corrections) ? rep!.corrections!.slice(0, 15) : null;
    if (corrections && corrections.length === 0) {
      // Le réparateur estime ne rien pouvoir corriger : inutile de payer un second passage.
      return { html: null, mode: 'cible', appliquees: 0 };
    }
    if (corrections) {
      const r = appliquerCorrections(page, corrections);
      if (r.ok && runScan1(r.html).ok) return { html: r.html, mode: 'cible', appliquees: r.appliquees };
      console.warn('[reparateur] Corrections ciblées non applicables proprement — retour au HTML complet.');
    } else {
      console.warn('[reparateur] Réponse ciblée illisible — retour au HTML complet.');
    }
  } catch (err) {
    console.warn('[reparateur] Corrections ciblées indisponibles — retour au HTML complet.', err);
  }

  // 2. Repli : HTML complet (ancien mode).
  try {
    const brut = await appeler(params.modele, promptComplet(page, params.erreurs, params.famille), 16000);
    const rep = parseJson<{ html_patch?: string }>(brut);
    const patch = rep?.html_patch?.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
    if (patch) return { html: sansKit(patch), mode: 'complet', appliquees: 0 };
  } catch (err) {
    console.warn('[reparateur] Réparation complète indisponible — page conservée.', err);
  }
  return { html: null, mode: null, appliquees: 0 };
}
