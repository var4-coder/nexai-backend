import { env } from '@/config/env';
import { callClaude } from '@/services/ai-clients';
import { AppError } from '@/middleware/errorHandler';
import { verifyImageUrl } from '@/utils/verifyMedia';

/**
 * Recraft API — génération de logos (et images d'embellissement).
 * Endpoint réel : https://external.api.recraft.ai/v1/images/generations
 * Clé : RECRAFT_API_KEY (Render Environment uniquement).
 */

const RECRAFT_BASE = 'https://external.api.recraft.ai/v1';

export interface RecraftImage {
  url: string;
  // champs éventuels renvoyés par l'API
  b64_json?: string;
}

/**
 * Génère une image (logo ou scène avec logo intégré).
 */
export async function generateImage(params: {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
}): Promise<RecraftImage[]> {
  if (!env.RECRAFT_API_KEY) {
    throw new AppError('RECRAFT_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const res = await fetch(`${RECRAFT_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RECRAFT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: params.prompt,
      model: params.model ?? 'recraftv4_1',
      size: params.size ?? '1024x1024',
      n: params.n ?? 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`Recraft API error ${res.status}: ${body.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const images: RecraftImage[] = (data.data || []).map((item) => ({
    url: item.url || '',
    b64_json: item.b64_json,
  }));

  if (!images.length) {
    throw new AppError('Recraft n\'a renvoyé aucune image', 502);
  }
  return images;
}

/**
 * 3 propositions de logo (règle Source de Vérité A.4 — toujours 3).
 */
export async function generateLogoProposals(brief: {
  brandName: string;
  niche: string;
  styleHints?: string;
  colors?: string;
}): Promise<{ versionId: string; url: string; prompt: string }[]> {
  // Claude Sonnet 5 rédige TOUJOURS les 3 prompts logo
  const system = `Tu es un expert en design de logos et en prompts pour Recraft / IA image.
Tu génères exactement 3 prompts distincts en anglais pour créer un logo professionnel.
Règles :
- Style clean, mémorable, utilisable sur fond clair et foncé
- Pas de texte illisible, pas de watermark, composition centrée
- Variante 1 : symbole minimal géométrique
- Variante 2 : monogramme élégant des initiales
- Variante 3 : pictogramme métier subtil lié à la niche
Réponds UNIQUEMENT en JSON : ["prompt1", "prompt2", "prompt3"]`;

  const user = `Marque : ${brief.brandName}
Niche : ${brief.niche}
${brief.styleHints ? `Direction style : ${brief.styleHints}` : ''}
${brief.colors ? `Couleurs : ${brief.colors}` : ''}`;

  let variants: string[] = [];
  try {
    const raw = await callClaude('claude-sonnet-5', system, [{ role: 'user', content: user }], {
      maxTokens: 800,
      temperature: 0.5,
    });
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length >= 3) {
      variants = parsed.slice(0, 3).map(String);
    }
  } catch (e) {
    console.warn('[recraft] Claude prompt fallback', e);
  }

  if (variants.length < 3) {
    const base = `Professional logo for "${brief.brandName}", niche ${brief.niche}. Clean, memorable, usable on light and dark backgrounds. No unreadable text, no watermark, centered composition.`;
    variants = [
      `${base} Variant 1: minimal geometric symbol.`,
      `${base} Variant 2: elegant monogram of initials.`,
      `${base} Variant 3: subtle industry pictogram related to ${brief.niche}.`,
    ];
  }

  const results: { versionId: string; url: string; prompt: string }[] = [];

  for (let i = 0; i < 3; i++) {
    // Contrôle : le client ne doit jamais recevoir un logo cassé. On génère,
    // on vérifie que l'image charge réellement, et on retente une fois si
    // besoin (Recraft renvoie parfois une URL momentanément indisponible)
    // avant d'abandonner — la règle "toujours 3" ne doit jamais se
    // transformer en "3 logos dont un cassé".
    let validUrl: string | null = null;
    for (let attempt = 0; attempt < 2 && !validUrl; attempt++) {
      const images = await generateImage({
        prompt: variants[i],
        model: 'recraftv4_1',
        size: '1024x1024',
        n: 1,
      });
      const candidateUrl = images[0].url;
      if (await verifyImageUrl(candidateUrl)) {
        validUrl = candidateUrl;
      } else {
        console.warn(`[recraft] Logo invalide (variante ${i + 1}, essai ${attempt + 1})`);
      }
    }

    if (!validUrl) {
      throw new AppError(`Recraft : impossible d'obtenir un logo valide pour la variante ${i + 1}`, 502);
    }

    results.push({
      versionId: `logo_${i + 1}`,
      url: validUrl,
      prompt: variants[i],
    });
  }

  return results;
}

/**
 * Image d'embellissement : logo intégré en fond ou scène décorative.
 * Réservé Agence + Pro Max (appliqué dans la route / service appelant).
 */
export async function generateEmbellishmentImage(params: {
  brandName: string;
  niche: string;
  logoDescription: string;
  mode: 'background' | 'decorative';
}): Promise<RecraftImage> {
  const prompt =
    params.mode === 'background'
      ? `Arrière-plan de site web professionnel pour "${params.brandName}" (${params.niche}). ` +
        `Intègre discrètement le logo suivant en filigrane élégant, non envahissant : ${params.logoDescription}. ` +
        `Ambiance premium, lumière douce, composition adaptée à un hero full-width, sans texte.`
      : `Image décorative premium pour site "${params.brandName}" (${params.niche}). ` +
        `Met en valeur le logo : ${params.logoDescription}. ` +
        `Style photographique ou illustration pro, utilisable en section ou carte, sans texte parasite.`;

  // Même contrôle que les logos : jamais d'image cassée présentée au
  // client, avec une tentative de retry avant d'abandonner.
  for (let attempt = 0; attempt < 2; attempt++) {
    const images = await generateImage({
      prompt,
      model: 'recraftv4_1_pro',
      size: params.mode === 'background' ? '1344x768' : '1024x1024',
      n: 1,
    });
    if (await verifyImageUrl(images[0].url)) {
      return images[0];
    }
    console.warn(`[recraft] Image d'embellissement invalide (essai ${attempt + 1})`);
  }

  throw new AppError("Recraft : impossible d'obtenir une image d'embellissement valide", 502);
}
