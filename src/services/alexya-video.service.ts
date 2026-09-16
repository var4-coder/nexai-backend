import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * AlexyaAI — génération vidéo.
 * Doc officielle : https://alexya.ai/api-docs
 *
 * POST /api/v1/video/generate  (async, 202 + poll_url)
 * - mode "best"      : silencieux, duration 5 ou 10s uniquement, pas de son
 * - mode "cinematic" : duration 3 à 15s, sound_enabled optionnel (true = narration/ambiance réelle)
 *
 * L'image de départ ne peut PAS être une URL externe brute : elle doit être
 * uploadée via /api/v1/uploads/presign (kind: "video_start_frame"), puis on
 * utilise le public_url retourné dans start_image_url.
 *
 * Coûts Alexya (crédits internes Alexya, pas NexAI) :
 * - best      : 28 cr/s   (280cr pour 10s)
 * - cinematic + son : 63 cr/s (315cr pour 5s)
 */

const ALEXYA_BASE = 'https://alexya.ai/api/v1';

function authHeaders() {
  if (!env.ALEXYA_API_KEY) {
    throw new AppError('ALEXYA_API_KEY manquante — configure-la sur Render', 503);
  }
  return {
    Authorization: `Bearer ${env.ALEXYA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Upload une image de départ (buffer, ex: frame extraite ou image générée)
 * vers le stockage Alexya via le flux presign obligatoire.
 */
export async function uploadVideoStartFrame(
  buffer: Buffer,
  contentType: string = 'image/jpeg'
): Promise<string> {
  const presignRes = await fetch(`${ALEXYA_BASE}/uploads/presign`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ kind: 'video_start_frame', content_type: contentType }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new AppError(`Alexya presign error ${presignRes.status}: ${text.slice(0, 400)}`, 502);
  }

  const presign = (await presignRes.json()) as { upload_url?: string; public_url?: string };
  if (!presign.upload_url || !presign.public_url) {
    throw new AppError('Alexya : réponse presign invalide (upload_url/public_url manquants)', 502);
  }

  const putRes = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
  });

  if (!putRes.ok) {
    throw new AppError(`Alexya : échec upload binaire (${putRes.status})`, 502);
  }

  return presign.public_url;
}

/** Upload à partir d'une URL déjà accessible (télécharge puis relaie vers Alexya). */
export async function uploadVideoStartFrameFromUrl(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new AppError(`Impossible de télécharger l'image de départ (${res.status})`, 502);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadVideoStartFrame(buffer, contentType);
}

async function pollVideoGeneration(
  pollUrl: string,
  maxAttempts = 90 // vidéo plus longue à générer que l'image → jusqu'à 3 min
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${env.ALEXYA_API_KEY}` },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      status?: string;
      output_url?: string;
      thumbnail_url?: string;
      error?: string;
    };
    if (data.status === 'completed' && data.output_url) {
      return { outputUrl: data.output_url, thumbnailUrl: data.thumbnail_url };
    }
    if (data.status === 'failed') {
      throw new AppError(`Alexya génération vidéo échouée: ${data.error || 'unknown'}`, 502);
    }
  }
  throw new AppError('Alexya : timeout génération vidéo', 504);
}

export interface GenerateVideoClipParams {
  prompt: string;
  mode: 'best' | 'cinematic';
  /** best: 5 ou 10 uniquement. cinematic: 3 à 15. */
  duration: number;
  startImageUrl: string; // doit déjà être un public_url Alexya (via uploadVideoStartFrame*)
  soundEnabled?: boolean; // uniquement valide en mode cinematic
  endImageUrl?: string; // cinematic single-shot uniquement
}

export async function generateAlexyaVideoClip(
  params: GenerateVideoClipParams
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  if (params.mode === 'best' && params.duration !== 5 && params.duration !== 10) {
    throw new AppError('Mode "best" : durée autorisée 5 ou 10 secondes uniquement.', 400);
  }
  if (params.mode === 'cinematic' && (params.duration < 3 || params.duration > 15)) {
    throw new AppError('Mode "cinematic" : durée autorisée entre 3 et 15 secondes.', 400);
  }
  if (params.soundEnabled && params.mode !== 'cinematic') {
    throw new AppError('Le son n\'est disponible qu\'en mode "cinematic".', 400);
  }

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    mode: params.mode,
    duration: params.duration,
    start_image_url: params.startImageUrl,
  };
  if (params.mode === 'cinematic') {
    if (params.soundEnabled !== undefined) body.sound_enabled = params.soundEnabled;
    if (params.endImageUrl) body.end_image_url = params.endImageUrl;
  }

  const res = await fetch(`${ALEXYA_BASE}/video/generate`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (res.status !== 202) {
    const text = await res.text();
    throw new AppError(`Alexya video error ${res.status}: ${text.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { poll_url?: string; id?: string };
  const pollUrl = data.poll_url || (data.id ? `${ALEXYA_BASE}/generations/${data.id}` : null);
  if (!pollUrl) throw new AppError('Alexya : pas de poll_url pour la génération vidéo', 502);

  return pollVideoGeneration(pollUrl);
}

/** Coût Alexya réel (en crédits internes Alexya) pour info/monitoring, pas facturé au client tel quel. */
export function estimateAlexyaCreditsForClip(mode: 'best' | 'cinematic', duration: number, soundEnabled: boolean): number {
  if (mode === 'best') return duration * 28;
  return soundEnabled ? Math.ceil(duration * 63) : Math.ceil(duration * 40); // cinematic sans son : tarif intermédiaire, à revérifier au dashboard
}
