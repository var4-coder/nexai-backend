import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * AlexyaAI — 2 images d'ambiance par site pour les plans payants (Créateur+).
 * API : https://alexya.ai/api/v1/image/generate
 * Clé : ALEXYA_API_KEY (Render Environment)
 */

const ALEXYA_BASE = 'https://alexya.ai/api/v1';

async function pollGeneration(pollUrl: string, apiKey: string, maxAttempts = 30): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      status?: string;
      output_url?: string;
      url?: string;
      image_url?: string;
      error?: string;
    };
    if (data.status === 'completed' && (data.output_url || data.url || data.image_url)) {
      return (data.output_url || data.url || data.image_url) as string;
    }
    if (data.status === 'failed') {
      throw new AppError(`Alexya génération échouée: ${data.error || 'unknown'}`, 502);
    }
  }
  throw new AppError('Alexya : timeout génération image', 504);
}

export async function generateAlexyaImage(params: {
  prompt: string;
  mode?: 'fast' | 'high_quality';
  aspectRatio?: string;
  imageUrls?: string[]; // logo Recraft en référence
}): Promise<{ url: string }> {
  if (!env.ALEXYA_API_KEY) {
    throw new AppError('ALEXYA_API_KEY manquante — configure-la sur Render', 503);
  }

  const res = await fetch(`${ALEXYA_BASE}/image/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ALEXYA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: params.prompt,
      mode: params.mode ?? 'high_quality',
      aspect_ratio: params.aspectRatio ?? '16:9',
      ...(params.imageUrls?.length ? { image_urls: params.imageUrls } : {}),
    }),
  });

  if (res.status === 202) {
    const data = (await res.json()) as { poll_url?: string; id?: string };
    const pollUrl = data.poll_url || (data.id ? `${ALEXYA_BASE}/generations/${data.id}` : null);
    if (!pollUrl) throw new AppError('Alexya : pas de poll_url', 502);
    const url = await pollGeneration(pollUrl, env.ALEXYA_API_KEY);
    return { url };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`Alexya error ${res.status}: ${text.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as {
    output_url?: string;
    url?: string;
    image_url?: string;
    data?: Array<{ url?: string }>;
  };
  const url = data.output_url || data.url || data.image_url || data.data?.[0]?.url;
  if (!url) throw new AppError('Alexya : aucune URL image', 502);
  return { url };
}

export function buildAlexyaSitePrompt(brief: {
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
  index: number;
}): string {
  const variants = [
    `Hero photoréaliste premium pour site ${brief.niche}, marque ${brief.brandName || ''}, large 16:9, lumière cinématique, sans texte.`,
    `Image décorative pro pour section services ${brief.niche}, marque ${brief.brandName || ''}, ambiance ${brief.tone || 'premium'}, sans texte ni watermark.`,
  ];
  const base = variants[brief.index % variants.length];
  return (
    base +
    (brief.description ? ` Contexte: ${brief.description}.` : '')
  );
}
