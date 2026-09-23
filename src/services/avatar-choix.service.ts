/**
 * Choix de l'avatar par le client.
 *
 * Kling AI Avatar n'a PAS de catalogue d'avatars prédéfinis : il anime un
 * portrait qu'on lui fournit. Le choix du client est donc entièrement
 * ouvert — on décrit le présentateur qu'il veut, on génère le portrait, et
 * Kling l'anime.
 *
 * Le choix est mémorisé sur le compte : un client retrouve le même
 * présentateur d'une vidéo à l'autre, ce qui construit une identité de
 * marque reconnaissable. Il peut en changer quand il le souhaite.
 *
 * Ne concerne que les modes avec avatar. La voix off n'en utilise aucun.
 */

export type AvatarGenre = 'homme' | 'femme';
export type AvatarCarnation = 'noire' | 'metisse' | 'claire';
export type AvatarAge = 'jeune' | 'adulte' | 'senior';
export type AvatarStyle = 'professionnel' | 'decontracte' | 'elegant';

export interface ChoixAvatar {
  genre: AvatarGenre;
  carnation: AvatarCarnation;
  age: AvatarAge;
  style: AvatarStyle;
}

/** Valeurs par défaut, si le client n'a encore rien choisi. */
export const AVATAR_DEFAUT: ChoixAvatar = {
  genre: 'femme',
  carnation: 'noire',
  age: 'adulte',
  style: 'professionnel',
};

/**
 * Options proposées au client, avec leur libellé d'affichage.
 * Exposées par l'API pour que le frontend n'ait rien à coder en dur.
 */
export const AVATAR_OPTIONS = {
  genre: [
    { valeur: 'femme', label: 'Femme' },
    { valeur: 'homme', label: 'Homme' },
  ],
  carnation: [
    { valeur: 'noire', label: 'Peau noire' },
    { valeur: 'metisse', label: 'Peau métisse' },
    { valeur: 'claire', label: 'Peau claire' },
  ],
  age: [
    { valeur: 'jeune', label: 'Jeune (20-30 ans)' },
    { valeur: 'adulte', label: 'Adulte (30-45 ans)' },
    { valeur: 'senior', label: 'Senior (45-60 ans)' },
  ],
  style: [
    { valeur: 'professionnel', label: 'Professionnel — tenue de bureau' },
    { valeur: 'decontracte', label: 'Décontracté — tenue de tous les jours' },
    { valeur: 'elegant', label: 'Élégant — tenue habillée' },
  ],
} as const;

const DESCRIPTIONS: Record<string, string> = {
  homme: 'man',
  femme: 'woman',
  noire: 'Black African, dark skin tone',
  metisse: 'mixed-race, medium brown skin tone',
  claire: 'light skin tone',
  jeune: 'in their mid-twenties',
  adulte: 'in their late thirties',
  senior: 'in their early fifties',
  professionnel: 'wearing smart business attire',
  decontracte: 'wearing neat casual clothing',
  elegant: 'wearing elegant formal clothing',
};

/** Normalise un choix partiel ou absent vers un choix complet et valide. */
export function normaliserChoixAvatar(brut: unknown): ChoixAvatar {
  const c = (brut ?? {}) as Partial<ChoixAvatar>;
  const valide = <T extends string>(v: unknown, liste: readonly { valeur: string }[], defaut: T): T =>
    liste.some((o) => o.valeur === v) ? (v as T) : defaut;

  return {
    genre: valide(c.genre, AVATAR_OPTIONS.genre, AVATAR_DEFAUT.genre),
    carnation: valide(c.carnation, AVATAR_OPTIONS.carnation, AVATAR_DEFAUT.carnation),
    age: valide(c.age, AVATAR_OPTIONS.age, AVATAR_DEFAUT.age),
    style: valide(c.style, AVATAR_OPTIONS.style, AVATAR_DEFAUT.style),
  };
}

/**
 * Construit le prompt du portrait à partir du choix du client.
 *
 * Le portrait est ensuite animé par Kling : tout défaut y est amplifié, d'où
 * les consignes de cadrage, de fond et d'éclairage, qui restent fixes.
 */
export function construirePromptPortrait(choix: ChoixAvatar, marque: string): string {
  const d = DESCRIPTIONS;
  return (
    `Photorealistic portrait of a ${d[choix.carnation]} ${d[choix.genre]} ${d[choix.age]}, ` +
    `${d[choix.style]}, upper body visible, facing camera directly, neutral studio background, ` +
    `soft natural lighting, warm and trustworthy expression, sharp focus on the face. ` +
    `Brand context: ${marque}. No text, no watermark, no logo.`
  );
}
