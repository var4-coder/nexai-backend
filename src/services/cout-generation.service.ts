/**
 * Coût réel des appels IA, et plafond de dépense par génération.
 *
 * Deux objectifs :
 *
 *  1. SAVOIR ce qu'une génération coûte vraiment. Les estimations d'un
 *     tableur valent ce qu'elles valent ; seul le nombre de tokens
 *     réellement consommé, renvoyé par les fournisseurs, dit la vérité.
 *
 *  2. BORNER l'exposition. Un fournisseur qui se comporte anormalement —
 *     réponses interminables, boucles — pourrait consommer bien plus que
 *     prévu. Le plafond arrête la génération et alerte, plutôt que de
 *     laisser filer la dépense.
 *
 * Les seuils laissent 20 % de marge au-dessus du pire cas LÉGITIME (bascule
 * de modèle et réparations comprises) : une génération normale, même
 * difficile, n'est jamais coupée.
 */

/**
 * Tarifs fournisseurs, en dollars par million de tokens.
 *
 * `lectureCache` : prix d'un token d'entrée relu depuis le cache du
 * fournisseur (consignes fixes de la Librairie). `ecritureCache` : prix
 * d'un token mis en cache (Anthropic facture 1,25 × l'entrée pour une durée
 * de 5 minutes ; xAI ne facture pas l'écriture).
 * Sources : docs Anthropic « Prompt caching » et xAI « Pricing » (09/2026).
 */
const TARIFS: Record<string, { entree: number; sortie: number; lectureCache: number; ecritureCache: number }> = {
  'grok-4.7': { entree: 2, sortie: 6, lectureCache: 0.5, ecritureCache: 2 },
  'grok-4.6': { entree: 2, sortie: 6, lectureCache: 0.5, ecritureCache: 2 },
  'grok-4.5': { entree: 2, sortie: 6, lectureCache: 0.3, ecritureCache: 2 },
  'grok-4.3': { entree: 1.25, sortie: 2.5, lectureCache: 0.2, ecritureCache: 1.25 },
  'grok-build-0.1': { entree: 1, sortie: 2, lectureCache: 0.2, ecritureCache: 1 },
  'claude-sonnet-5': { entree: 2, sortie: 10, lectureCache: 0.2, ecritureCache: 2.5 },
  'claude-opus-5-5': { entree: 4, sortie: 20, lectureCache: 0.2, ecritureCache: 5 },
  // Ancien modèle, gardé pour chiffrer correctement l'historique.
  'claude-opus-5': { entree: 5, sortie: 25, lectureCache: 0.5, ecritureCache: 6.25 },
  'claude-fable-5-1': { entree: 10, sortie: 50, lectureCache: 0.25, ecritureCache: 12.5 },
  'claude-haiku-4-5-20251001': { entree: 1, sortie: 5, lectureCache: 0.1, ecritureCache: 1.25 },
};

/** Tokens d'entrée passés par le cache du fournisseur. */
export interface UsageCache {
  /** Tokens relus depuis le cache (facturés au tarif réduit). */
  lecture?: number;
  /** Tokens écrits dans le cache (Anthropic : 1,25 × l'entrée). */
  ecriture?: number;
}

/**
 * Coût en dollars d'un appel, d'après les tokens réellement consommés.
 * `tokensEntree` = tokens d'entrée HORS cache.
 */
export function coutAppelUsd(
  modele: string,
  tokensEntree: number,
  tokensSortie: number,
  cache?: UsageCache
): number {
  const t = TARIFS[modele];
  // Modèle inconnu : on ne devine pas un tarif, on ne compte rien plutôt
  // que d'afficher un chiffre faux.
  if (!t) return 0;
  return (
    (tokensEntree * t.entree +
      tokensSortie * t.sortie +
      (cache?.lecture ?? 0) * t.lectureCache +
      (cache?.ecriture ?? 0) * t.ecritureCache) /
    1e6
  );
}

export type TypeGeneration = 'essai' | 'normale' | 'premium';

/**
 * Plafond de dépense par génération, en dollars.
 *
 * Au-delà, la génération s'arrête et l'administrateur est alerté. Ces
 * valeurs laissent 20 % au-dessus du pire cas légitime :
 *  · essai    : plafond 0,90 $ — l'essai livre le site COMPLET (pages
 *    intérieures jugées comprises) : 0,63 à 0,87 $ pour 3-4 pages
 *  · normale  : plafond 1,50 $ (décision admin 26/09/2026 : la Librairie
 *    complète et les pages intérieures jugées augmentent le pire cas)
 *  · premium  : 1,62 $ au pire → plafond 2,20 $ (marge plancher 52 %)
 */
export const PLAFOND_DEPENSE_USD: Record<TypeGeneration, number> = {
  essai: 0.9,
  normale: 1.5,
  premium: 2.2,
};

/** Dépense cumulée d'une génération en cours. */
export class CompteurDepense {
  private total = 0;
  private readonly details: { modele: string; usd: number }[] = [];

  constructor(private readonly type: TypeGeneration) {}

  /** Enregistre un appel et renvoie son coût. */
  ajouter(modele: string, tokensEntree: number, tokensSortie: number, cache?: UsageCache): number {
    const usd = coutAppelUsd(modele, tokensEntree, tokensSortie, cache);
    this.total += usd;
    this.details.push({ modele, usd });
    return usd;
  }

  /** Reprend la dépense déjà engagée sur cette commande (reprises). */
  reprendre(usd: number): void {
    if (usd > 0) this.total = usd;
  }

  get totalUsd(): number {
    return this.total;
  }

  get plafondUsd(): number {
    return PLAFOND_DEPENSE_USD[this.type];
  }

  /** Le plafond est-il atteint ? */
  get depasse(): boolean {
    return this.total >= this.plafondUsd;
  }

  /** Répartition par modèle, pour l'administration. */
  repartition(): Record<string, number> {
    const parModele: Record<string, number> = {};
    for (const d of this.details) {
      parModele[d.modele] = Number(((parModele[d.modele] ?? 0) + d.usd).toFixed(4));
    }
    return parModele;
  }
}
