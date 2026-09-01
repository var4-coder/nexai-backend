import { callClaude } from '@/services/ai-clients';

/**
 * Scan qualité du brief AVANT toute génération vidéo (et avant tout débit de
 * crédits) — décision produit : quand le client fournit une URL de site, le
 * pipeline a déjà accès au titre/description/H1/logo réels (site-meta.service),
 * donc ce scan est inutile et n'est jamais déclenché dans ce cas. Il ne
 * s'applique QUE quand le client décrit sa vidéo en texte libre, sans site à
 * analyser — c'est là que Claude risque de devoir "halluciner" des détails
 * (marque, promesse, cible) faute d'information, et qu'un mauvais brief
 * produit un mauvais script.
 *
 * Utilisé à deux niveaux :
 * - Frontend (UX) : appel proactif avant le clic "Générer", pour guider le
 *   client en temps réel (voir POST /video-ads/analyser-brief).
 * - Backend (garde-fou réel) : ré-appelé dans enqueueVideoAd juste avant le
 *   débit de crédits — un client qui contournerait le frontend (appel direct
 *   à l'API) reste bloqué de la même façon. Le frontend n'est jamais la seule
 *   ligne de défense.
 */

export interface VideoBriefAnalysis {
  complete: boolean;
  /** Éléments manquants ou trop vagues, en langage client (pas de jargon technique). */
  missingElements: string[];
  /** Message actionnable à afficher au client, qui explique quoi préciser et pourquoi. */
  feedback: string;
}

const MIN_WORDS_HEURISTIC_FALLBACK = 12;

function parseAnalysisJson(raw: string): VideoBriefAnalysis | null {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<VideoBriefAnalysis>;
    if (typeof parsed.complete !== 'boolean') return null;
    return {
      complete: parsed.complete,
      missingElements: Array.isArray(parsed.missingElements) ? parsed.missingElements.slice(0, 6) : [],
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
    };
  } catch {
    return null;
  }
}

/**
 * Analyse la description libre (+ marque/CTA si déjà fournis) et juge si le
 * brief contient assez d'éléments concrets pour écrire un script publicitaire
 * cohérent : QUOI (produit/service), POUR QUI/QUEL BÉNÉFICE, et une identité
 * de marque minimale. Si Claude est indisponible, on retombe sur une
 * heuristique simple (nombre de mots) plutôt que de bloquer toute génération
 * pour une panne d'infrastructure — mais on ne désactive jamais complètement
 * le contrôle : mieux vaut un filtre imparfait qu'aucun filtre.
 */
export async function analyzeVideoBriefCompleteness(params: {
  description?: string;
  brandName?: string;
  ctaText?: string;
}): Promise<VideoBriefAnalysis> {
  const description = (params.description || '').trim();

  if (!description) {
    return {
      complete: false,
      missingElements: ['Description de la vidéo'],
      feedback:
        "Vous n'avez pas encore décrit votre vidéo. Expliquez ce que vous vendez, à qui, et ce qui vous rend différent — quelques phrases suffisent.",
    };
  }

  const system = `Tu es l'assistant qualité brief de NexAI. Un client va lancer la génération d'une publicité vidéo IA à partir de sa description, SANS URL de site à analyser en complément — le script publicitaire sera écrit uniquement à partir de ce qu'il donne ici.
Ton rôle : juger si cette description contient assez d'éléments CONCRETS pour écrire une pub cohérente et pas générique. Vérifie précisément :
1. QUOI : le produit/service est-il identifiable clairement (pas juste "mon entreprise" ou "mes services") ?
2. BÉNÉFICE/CIBLE : y a-t-il une promesse ou un public visé, même implicite (pas juste une liste de features sans angle) ?
3. IDENTITÉ DE MARQUE : un nom de marque ou un univers de ton est-il présent ou déductible (le champ "Nom de marque" séparé compte aussi si fourni) ?
Sois exigeant mais raisonnable : une description de 2-3 phrases précises est suffisante et ne doit PAS être rejetée juste parce qu'elle est courte. Rejette seulement les briefs réellement vagues ("un site cool pour mon business", "une pub qui donne envie d'acheter").
Réponds UNIQUEMENT en JSON strict, sans texte autour :
{"complete": boolean, "missingElements": string[] (vide si complete=true, sinon 1 à 3 éléments concrets manquants, en français, formulés simplement pour le client), "feedback": string (1 à 2 phrases en français, direct et bienveillant, qui dit précisément quoi ajouter et pourquoi — jamais un simple "soyez plus précis" sans direction concrète)}`;

  const user = `Description fournie par le client : "${description}"
Nom de marque déjà renseigné : ${params.brandName || '(aucun)'}
Texte du CTA déjà renseigné : ${params.ctaText || '(aucun)'}`;

  try {
    const raw = await callClaude('claude-sonnet-5', system, [{ role: 'user', content: user }], {
      maxTokens: 300,
      temperature: 0.2,
    });
    const parsed = parseAnalysisJson(raw);
    if (parsed) return parsed;
  } catch (err) {
    console.warn('[video-brief-quality] Analyse Claude indisponible, repli sur heuristique simple', err);
  }

  // Repli heuristique si Claude est indisponible ou renvoie un format inattendu.
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS_HEURISTIC_FALLBACK) {
    return {
      complete: false,
      missingElements: ['Description plus détaillée'],
      feedback:
        'Votre description est un peu courte pour écrire une pub vraiment ciblée. Ajoutez ce que vous vendez, à qui, et votre principal argument.',
    };
  }
  return { complete: true, missingElements: [], feedback: '' };
}
