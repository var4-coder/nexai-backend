import { callClaude } from '@/services/ai-clients';


/**
 * Contrôle de CLARTÉ de la demande, avant de lancer une génération.
 *
 * Le contrôle existant (validateBriefQuality) vérifie la PRÉSENCE et la
 * LONGUEUR des champs. Il laisse donc passer des demandes complètes en
 * apparence mais inexploitables :
 *
 *   « Je vends des produits de qualité à des clients exigeants »
 *
 * Quatorze mots, une cible, une marque — et on ignore toujours ce qui est
 * vendu. Aucun site correct ne peut en sortir, et c'est la première cause
 * des sites que les juges refusent ensuite.
 *
 * Ce contrôle pose la vraie question : peut-on construire un site à partir
 * de cette demande ? Il ne bloque jamais — il renvoie la question précise
 * qui manque, pour que le chat la pose au client sans lui donner le
 * sentiment d'avoir échoué.
 */

export interface ClarteBrief {
  clair: boolean;
  /** Question à poser au client, formulée simplement. Vide si clair. */
  question: string;
}

/** Extraction JSON tolérante : le modèle peut entourer sa réponse de texte. */
function lireJson<T>(brut: string): T | null {
  try {
    const nettoye = brut.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const debut = nettoye.indexOf('{');
    const fin = nettoye.lastIndexOf('}');
    if (debut === -1 || fin === -1) return null;
    return JSON.parse(nettoye.slice(debut, fin + 1)) as T;
  } catch {
    return null;
  }
}

const MODELE = 'claude-haiku-4-5-20251001';

const CONSIGNE = `Tu vérifies si la demande d'un commerçant permet de créer son site web.

Trois points doivent être compréhensibles :
1. CE QU'IL VEND ou propose, concrètement (pas « des produits », « des services »)
2. À QUI il s'adresse
3. Ce qui le distingue, ou au moins un détail concret sur son activité

Sois INDULGENT. Une description courte mais concrète est SUFFISANTE :
« vente de pagnes wax » → CLAIR. « coiffure à domicile » → CLAIR.
Ne rejette que les demandes réellement vagues, où l'on ne sait pas ce qui est vendu.

Si un point manque, formule UNE question simple, chaleureuse, en tutoyant
le commerçant, qui l'aide à préciser. Jamais de reproche, jamais de jargon.

Réponds UNIQUEMENT en JSON :
{"clair": true} ou {"clair": false, "question": "..."}`;

export async function verifierClarteBrief(
  brief: Record<string, unknown>
): Promise<ClarteBrief> {
  const resume = [
    brief.brandName && `Marque : ${brief.brandName}`,
    brief.description && `Activité : ${brief.description}`,
    brief.cible && `Cible : ${brief.cible}`,
    Array.isArray(brief.capacites) && brief.capacites.length > 0
      ? `Propose : ${(brief.capacites as string[]).join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const brut = await callClaude(
      MODELE,
      CONSIGNE,
      [{ role: 'user', content: resume }],
      { maxTokens: 300, temperature: 0 }
    );
    const verdict = lireJson<{ clair?: boolean; question?: string }>(brut);

    // Aucun verdict exploitable : on laisse passer. Bloquer un client sur une
    // réponse qu'on ne comprend pas serait le pire des deux mondes.
    if (!verdict || typeof verdict.clair !== 'boolean') {
      return { clair: true, question: '' };
    }
    if (verdict.clair) return { clair: true, question: '' };

    return {
      clair: false,
      question:
        verdict.question?.trim() ||
        "Peux-tu préciser ce que tu vends ou proposes exactement ? Ça m'aidera à créer un site qui te ressemble.",
    };
  } catch (err) {
    // Panne du contrôle : on laisse passer. Un filtre indisponible ne doit
    // jamais empêcher un client de créer son site.
    console.warn('[clarte-brief] Contrôle indisponible, demande acceptée', err);
    return { clair: true, question: '' };
  }
}
