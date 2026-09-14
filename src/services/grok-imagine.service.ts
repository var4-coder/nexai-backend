import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Grok Imagine (xAI) — images pour l'essai gratuit (1 image / site).
 * Endpoint : https://api.x.ai/v1
 * Clé : XAI_API_KEY
 */

const XAI_BASE = 'https://api.x.ai/v1';

export async function generateGrokImagine(params: {
  prompt: string;
  aspectRatio?: string;
  imageUrl?: string; // logo Recraft en référence (optionnel)
}): Promise<{ url: string }> {
  if (!env.XAI_API_KEY) {
    throw new AppError('XAI_API_KEY manquante — configure-la sur Render', 503);
  }

  // Génération simple (text-to-image) ou edit si logo fourni
  const isEdit = Boolean(params.imageUrl);
  const endpoint = isEdit ? `${XAI_BASE}/images/edits` : `${XAI_BASE}/images/generations`;

  const body: Record<string, unknown> = {
    model: 'grok-imagine-image',
    prompt: params.prompt,
    n: 1,
  };

  if (params.aspectRatio) {
    body.aspect_ratio = params.aspectRatio;
  }

  if (isEdit && params.imageUrl) {
    body.image = { url: params.imageUrl, type: 'image_url' };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

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
