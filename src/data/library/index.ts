/**
 * Librairie interne NexAI — SECOND SECOURS à la librairie MongoDB.
 *
 * Source : NexAI_Source_de_Verite_Finale.pdf (Partie B — Bibliothèque design & contenu).
 * Embarquée en dur dans le backend pour que la génération de site continue de fonctionner
 * même si MongoDB est indisponible, en attente de reconnexion, ou si une niche/collection
 * n'a pas (encore) de document seedé.
 *
 * Ne JAMAIS considérer cette librairie comme la source de vérité principale : c'est un filet
 * de sécurité. Toute mise à jour de fond de la bibliothèque doit d'abord être faite dans
 * MongoDB ; ce module n'a vocation qu'à éviter une panne totale de génération.
 */

import { INTERNAL_NICHES, LibraryNicheDoc } from './niches';
import { INTERNAL_TOKENS } from './tokens';
import { INTERNAL_PALETTES, LibraryPaletteDoc } from './palettes';
import { INTERNAL_ANTI_SLOP } from './antiSlop';
import { INTERNAL_COMPONENTS, LibraryComponentDoc } from './components';
import { INTERNAL_COPY, COPY_REGLES_COMMUNES, LibraryCopyDoc } from './copy';

export interface InternalLibraryBundle {
  niche: LibraryNicheDoc | null;
  tokens: typeof INTERNAL_TOKENS;
  palette: LibraryPaletteDoc | null;
  antiSlop: typeof INTERNAL_ANTI_SLOP;
  components: LibraryComponentDoc[];
  copy: (LibraryCopyDoc & { regles_communes?: typeof COPY_REGLES_COMMUNES }) | null;
}

/**
 * Charge le paquet complet de librairie interne pour une niche donnée.
 * Retourne toujours tokens + antiSlop (globaux, non spécifiques à la niche).
 * niche / palette / copy peuvent être `null` si le slug de niche est inconnu
 * (cas normal pour une niche hors des 10 officielles, ou une faute de frappe) ;
 * dans ce cas le fallback ultime générique de library.service.ts prend le relais.
 */
export function loadInternalLibraryForNiche(niche: string): InternalLibraryBundle {
  const nicheDoc = INTERNAL_NICHES.find((n) => n.slug === niche) || null;
  const paletteDoc = INTERNAL_PALETTES.find((p) => p.niche === niche) || null;
  const copyDoc = INTERNAL_COPY.find((c) => c.niche === niche) || null;

  const allowedIds = nicheDoc?.composants_autorises;
  let components = allowedIds
    ? INTERNAL_COMPONENTS.filter((c) => allowedIds.includes(c.id))
    : INTERNAL_COMPONENTS.filter((c) => c.niches.includes('*'));

  // Même tirage aléatoire contrôlé que loadLibraryForNiche (max 12), pour un comportement cohérent
  components = [...components].sort(() => Math.random() - 0.5).slice(0, 12);

  // Alignement de forme avec les documents Mongo consommés par libraryToCoderContext
  // (champ `data_nexai_ids` en tableau, en plus de `data_nexai_id` singulier pour lisibilité).
  const componentsForContext = components.map((c) => ({
    ...c,
    data_nexai_ids: [c.data_nexai_id],
  })) as unknown as LibraryComponentDoc[];

  return {
    niche: nicheDoc,
    tokens: INTERNAL_TOKENS,
    palette: paletteDoc,
    antiSlop: INTERNAL_ANTI_SLOP,
    components: componentsForContext,
    copy: copyDoc ? { ...copyDoc, regles_communes: COPY_REGLES_COMMUNES } : null,
  };
}

export {
  INTERNAL_NICHES,
  INTERNAL_TOKENS,
  INTERNAL_PALETTES,
  INTERNAL_ANTI_SLOP,
  INTERNAL_COMPONENTS,
  INTERNAL_COPY,
  COPY_REGLES_COMMUNES,
};
