import { callClaudeVision } from '@/services/ai-clients';

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

/* ─────────────────────────── Mon propre visage ─────────────────────────── */

/**
 * Contrôle automatique de la photo envoyée pour « Mon propre visage ».
 *
 * Le moteur anime le visage tel quel : une photo floue, de profil, à
 * plusieurs ou d'une célébrité donnerait une vidéo ratée ou interdite. On
 * refuse donc avant de débiter quoi que ce soit, avec une raison claire.
 * En cas d'indisponibilité du contrôle, la photo est refusée (jamais
 * acceptée par défaut).
 */
export async function verifierPhotoAvatar(url: string): Promise<{ ok: boolean; raison?: string }> {
  const system =
    'Tu contrôles une photo envoyée par un client pour devenir le présentateur animé de ses publicités vidéo. ' +
    'Réponds UNIQUEMENT en JSON strict : {"ok":true|false,"raison":"phrase courte en français, adressée au client, si refus"}.';
  const prompt = `Accepte la photo SEULEMENT si toutes ces conditions sont réunies :
1. Une seule personne réelle (pas un dessin, une statue, une photo d'écran ni une image générée évidente).
2. Le visage est net, entièrement visible, de face ou presque (pas de profil), sans lunettes de soleil ni masque, bien éclairé.
3. La personne est manifestement adulte.
4. Tenue correcte : aucune nudité, rien de choquant.
5. Ce n'est pas une célébrité, une personnalité politique ou une personne connue reconnaissable.
6. Le visage occupe une part suffisante de l'image (portrait, buste ou plan taille).
En cas de doute sur 3 ou 5, refuse. La raison explique quoi corriger (ex. « Votre visage est trop petit : prenez une photo plus rapprochée, de face. »).`;
  try {
    const brut = await callClaudeVision('claude-sonnet-5-5', system, prompt, [url], { maxTokens: 200 });
    const m = brut.match(/\{[\s\S]*\}/);
    const r = m ? (JSON.parse(m[0]) as { ok?: unknown; raison?: unknown }) : null;
    if (!r) throw new Error('réponse illisible');
    return r.ok === true
      ? { ok: true }
      : { ok: false, raison: typeof r.raison === 'string' && r.raison ? r.raison.slice(0, 200) : 'Cette photo ne convient pas. Envoyez une photo nette de votre visage, de face.' };
  } catch {
    return { ok: false, raison: 'La vérification de la photo est momentanément indisponible. Réessayez dans un instant.' };
  }
}

/**
 * Recadre la photo du client au format de la vidéo, centrée sur le visage
 * (transformation Cloudinary, sans nouvel envoi).
 */
export function portraitAuFormat(url: string, aspectRatio: string): string {
  if (!/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url)) return url;
  const ar = aspectRatio === '16:9' ? '16:9' : aspectRatio === '1:1' ? '1:1' : '9:16';
  const largeur = ar === '16:9' ? 1280 : ar === '1:1' ? 1080 : 720;
  return url.replace('/image/upload/', `/image/upload/c_fill,g_face,ar_${ar},w_${largeur},q_auto:good,f_jpg/`);
}
