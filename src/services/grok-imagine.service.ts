import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { fetchWithRetry } from '@/services/ai-clients';

/**
 * Grok Imagine (xAI) — images d'ambiance de site et images de départ vidéo.
 * Endpoint : https://api.x.ai/v1
 * Clé : XAI_API_KEY
 */

const XAI_BASE = 'https://api.x.ai/v1';

/**
 * Palier de modèle.
 *
 * - 'standard' → grok-imagine-image (~0,02 $/image). Réservé à l'ESSAI GRATUIT
 *   et au test vidéo 8s : le coût d'acquisition doit rester bas.
 * - 'v2'       → grok-imagine-image-2.0 (~0,04 $/image). Utilisé pour tout ce
 *   qui est PAYANT : aperçus de site et images de départ des vidéos.
 *
 * Pourquoi la 2.0 sur les images de départ vidéo en particulier : en
 * image-to-video, le moindre défaut du premier plan est amplifié sur 10
 * secondes de mouvement. Un logo légèrement déformé passe inaperçu sur une
 * image fixe, mais devient très visible dès qu'il bouge. La meilleure fidélité
 * d'édition de la 2.0 sert donc directement la qualité vidéo finale, pour
 * 0,02 $ de plus par scène (négligeable face au coût vidéo).
 */
export type GrokImageTier = 'standard' | 'v2';

const GROK_IMAGE_MODELS: Record<GrokImageTier, string> = {
  standard: 'grok-imagine-image',
  v2: 'grok-imagine-image-2.0',
};

export async function generateGrokImagine(params: {
  prompt: string;
  aspectRatio?: string;
  imageUrl?: string; // logo Recraft en référence (optionnel)
  /**
   * Palier de modèle. Par défaut 'standard' : les appels existants qui ne
   * précisent rien gardent exactement le comportement et le coût d'avant.
   */
  tier?: GrokImageTier;
}): Promise<{ url: string }> {
  if (!env.XAI_API_KEY) {
    throw new AppError('XAI_API_KEY manquante — configure-la sur Render', 503);
  }

  // Génération simple (text-to-image) ou edit si logo fourni
  const isEdit = Boolean(params.imageUrl);
  const endpoint = isEdit ? `${XAI_BASE}/images/edits` : `${XAI_BASE}/images/generations`;

  const body: Record<string, unknown> = {
    model: GROK_IMAGE_MODELS[params.tier ?? 'standard'],
    prompt: params.prompt,
    n: 1,
  };

  if (params.aspectRatio) {
    body.aspect_ratio = params.aspectRatio;
  }

  if (isEdit && params.imageUrl) {
    body.image = { url: params.imageUrl, type: 'image_url' };
  }

  // Timeout + retry (réseau/429/5xx) — même mécanisme que callGrok/callClaude
  // dans ai-clients.ts. Avant, cet appel n'avait ni l'un ni l'autre : une
  // réponse lente ou instable de xAI pouvait bloquer indéfiniment le job en
  // cours (aucun AbortController), au lieu d'échouer proprement ou de
  // réessayer comme le reste des appels IA.
  const res = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    `xAI/${GROK_IMAGE_MODELS[params.tier ?? 'standard']}`
  );

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`Grok Imagine error ${res.status}: ${text.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as {
    data?: Array<{ url?: string }>;
    url?: string;
    images?: Array<{ url?: string }>;
  };
  // Formats possibles selon version API
  const url =
    data.data?.[0]?.url ||
    data.url ||
    data.images?.[0]?.url ||
    null;

  if (!url) {
    throw new AppError('Grok Imagine : aucune URL image renvoyée', 502);
  }

  return { url };
}

/**
 * Prompt personnalisé pour 1 image d'ambiance (essai).
 */
export function buildSiteImagePrompt(brief: {
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
}): string {
  const brand = brief.brandName || 'la marque';
  return (
    `Photographie professionnelle réaliste pour le hero d'un site web ${brief.niche}. ` +
    `Marque : ${brand}. ` +
    (brief.description ? `Contexte : ${brief.description}. ` : '') +
    (brief.tone ? `Ambiance : ${brief.tone}. ` : 'Ambiance premium, pro, accueillante. ') +
    `Composition large 16:9, lumière naturelle, sans texte, sans watermark, qualité site vitrine.`
  );
}
