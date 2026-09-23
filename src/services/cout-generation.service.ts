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

/** Tarifs fournisseurs, en dollars par million de tokens. */
const TARIFS: Record<string, { entree: number; sortie: number }> = {
  'grok-4.7': { entree: 2, sortie: 6 },
  'grok-4.6': { entree: 2, sortie: 6 },
  'grok-4.5': { entree: 2, sortie: 6 },
  'grok-4.3': { entree: 1.25, sortie: 2.5 },
  'grok-build-0.1': { entree: 1, sortie: 2 },
  'claude-sonnet-5': { entree: 2, sortie: 10 },
  'claude-opus-5': { entree: 5, sortie: 25 },
  'claude-fable-5-1': { entree: 10, sortie: 50 },
  'claude-haiku-4-5-20251001': { entree: 1, sortie: 5 },
};

/** Coût en dollars d'un appel, d'après les tokens réellement consommés. */
export function coutAppelUsd(modele: string, tokensEntree: number, tokensSortie: number): number {
  const t = TARIFS[modele];
  // Modèle inconnu : on ne devine pas un tarif, on ne compte rien plutôt
  // que d'afficher un chiffre faux.
  if (!t) return 0;
  return (tokensEntree * t.entree + tokensSortie * t.sortie) / 1e6;
}

export type TypeGeneration = 'essai' | 'normale' | 'premium';

/**
 * Plafond de dépense par génération, en dollars.
 *
 * Au-delà, la génération s'arrête et l'administrateur est alerté. Ces
 * valeurs laissent 20 % au-dessus du pire cas légitime :
 *  · essai    : 0,49 $ au pire → plafond 0,60 $
 *  · normale  : 1,00 $ au pire → plafond 1,20 $ (marge plancher 45 %)
 *  · premium  : 1,62 $ au pire → plafond 2,20 $ (marge plancher 52 %)
 */
export const PLAFOND_DEPENSE_USD: Record<TypeGeneration, number> = {
  essai: 0.6,
  normale: 1.2,
  premium: 2.2,
};

/** Dépense cumulée d'une génération en cours. */
export class CompteurDepense {
  private total = 0;
  private readonly details: { modele: string; usd: number }[] = [];

  constructor(private readonly type: TypeGeneration) {}

  /** Enregistre un appel et renvoie son coût. */
  ajouter(modele: string, tokensEntree: number, tokensSortie: number): number {
    const usd = coutAppelUsd(modele, tokensEntree, tokensSortie);
    this.total += usd;
    this.details.push({ modele, usd });
    return usd;
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
