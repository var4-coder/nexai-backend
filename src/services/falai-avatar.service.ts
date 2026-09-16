import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * FalAI — Kling AI Avatar v2 (Standard + Pro).
 * Doc : https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard/api
 *       https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro/api
 *
 * Transforme une image de portrait + un fichier audio en vidéo "avatar qui
 * parle" (lipsync). Contrainte FalAI/Kling : l'audio en entrée doit faire
 * entre 2 et 60 secondes MAX par appel — pas de génération >60s en un seul
 * call, quel que soit le plan.
 *
 * → Avatar Mode Standard (30s/60s) : 1 seul appel, endpoint "standard".
 * → Avatar Mode Scénario (120s) : 2 appels "pro" de 60s chaînés (même image
 *   de personnage à chaque segment pour la continuité visuelle), concaténés
 *   ensuite via ffmpeg — même principe que le montage multi-scènes Alexya.
 *
 * Tarifs (facturés par FalAI, à la seconde de vidéo générée) :
 * - Standard : $0.0562/s
 * - Pro      : $0.115/s
 */

const FALAI_BASE = 'https://fal.run/fal-ai/kling-video/ai-avatar/v2';
const FALAI_QUEUE_BASE = 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2';

function authHeaders() {
  if (!env.FALAI_API_KEY) {
    throw new AppError('FALAI_API_KEY manquante — configure-la sur Render', 503);
  }
  return {
    Authorization: `Key ${env.FALAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export type AvatarQuality = 'standard' | 'pro';

/** Durée max d'un seul appel FalAI Kling Avatar (contrainte fournisseur, pas NexAI). */
export const FALAI_AVATAR_MAX_SECONDS_PER_CALL = 60;

export interface GenerateAvatarClipParams {
  /** URL publique de l'image de portrait (Grok Imagine, déjà hébergée). */
  imageUrl: string;
  /** URL publique du fichier audio (narration TTS ElevenLabs, déjà hébergée). Doit faire 2-60s. */
  audioUrl: string;
  quality: AvatarQuality;
  /** Prompt optionnel : émotions/gestes/mouvements de caméra du personnage. */
  prompt?: string;
}

async function pollFalaiQueue(
  quality: AvatarQuality,
  requestId: string,
  maxAttempts = 90
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  const statusUrl = `${FALAI_QUEUE_BASE}/${quality}/requests/${requestId}/status`;
  const resultUrl = `${FALAI_QUEUE_BASE}/${quality}/requests/${requestId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(statusUrl, { headers: authHeaders() });
    if (!res.ok) continue;
    const data = (await res.json()) as { status?: string };

    if (data.status === 'COMPLETED') {
      const resultRes = await fetch(resultUrl, { headers: authHeaders() });
      if (!resultRes.ok) {
        throw new AppError(`FalAI : échec récupération résultat (${resultRes.status})`, 502);
      }
      const result = (await resultRes.json()) as {
        video?: { url?: string };
        thumbnail?: { url?: string };
      };
      if (!result.video?.url) {
        throw new AppError('FalAI : réponse complétée sans URL vidéo', 502);
      }
      return { outputUrl: result.video.url, thumbnailUrl: result.thumbnail?.url };
    }
    if (data.status === 'ERROR') {
      throw new AppError('FalAI : génération avatar échouée (status ERROR)', 502);
    }
    // IN_QUEUE / IN_PROGRESS → on continue de poller
  }
  throw new AppError('FalAI : timeout génération avatar', 504);
}

/**
 * Génère UN segment avatar (max 60s, contrainte fournisseur — voir
 * FALAI_AVATAR_MAX_SECONDS_PER_CALL). Pour le Mode Scénario (120s), on
 * appelle cette fonction 2 fois (voir generateAvatarScenario ci-dessous).
 */
export async function generateAvatarClip(
  params: GenerateAvatarClipParams
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  const endpoint = `${FALAI_QUEUE_BASE}/${params.quality}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      image_url: params.imageUrl,
      audio_url: params.audioUrl,
      ...(params.prompt ? { prompt: params.prompt.slice(0, 2500) } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`FalAI avatar error ${res.status}: ${text.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) {
    throw new AppError('FalAI : pas de request_id retourné pour la génération avatar', 502);
  }

  return pollFalaiQueue(params.quality, data.request_id);
}

/** Coût FalAI réel (en $) pour info/monitoring — pas facturé au client tel quel. */
export function estimateFalaiCostUsd(quality: AvatarQuality, durationSeconds: number): number {
  const ratePerSecond = quality === 'pro' ? 0.115 : 0.0562;
  return Math.round(durationSeconds * ratePerSecond * 100) / 100;
}
