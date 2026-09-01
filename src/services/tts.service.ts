import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * TTS — ElevenLabs.
 * Utilisé pour :
 * - Option 1 "voix off + musique" : narration ajoutée par-dessus les clips
 *   Alexya silencieux (mode "best").
 * - Option 2 "Avatar" (Standard + Scénario) : la voix qui alimente le lipsync
 *   FalAI Kling Avatar (audio_url en entrée).
 *
 * Doc : https://elevenlabs.io/docs/api-reference/text-to-speech
 * Coût réel (indicatif, non facturé tel quel au client) : ~$0.02 à $0.09 par
 * vidéo selon la longueur du script — négligeable face au coût vidéo principal
 * (Alexya / FalAI), déjà intégré dans la grille CREDIT_COSTS.
 */

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export interface TtsResult {
  /** Buffer audio brut (mp3) — à uploader (Cloudinary) ou écrire sur disque directement. */
  audioBuffer: Buffer;
  contentType: string;
}

/**
 * Tire une voix au sort dans le pool configuré (ELEVENLABS_VOICE_IDS), pour
 * ne pas resservir systématiquement la même voix à tous les clients.
 * Fallback sur ELEVENLABS_VOICE_ID (voix unique) si le pool est vide/mal
 * configuré — comportement identique à avant dans ce cas.
 */
export function pickVoiceId(): string {
  const pool = env.ELEVENLABS_VOICE_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (pool.length === 0) return env.ELEVENLABS_VOICE_ID;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Synthétise un texte en voix off (mp3).
 * `voiceId` optionnel : permet de garder une voix cohérente pour un même
 * personnage/présentateur récurrent (Avatar) — sinon utilise la voix par
 * défaut NexAI (env.ELEVENLABS_VOICE_ID).
 */
export async function synthesizeSpeech(
  text: string,
  opts?: { voiceId?: string; stability?: number; similarityBoost?: number }
): Promise<TtsResult> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new AppError('ELEVENLABS_API_KEY manquante — configure-la sur Render', 503);
  }
  if (!text || !text.trim()) {
    throw new AppError('Texte de narration vide — impossible de générer la voix off.', 400);
  }

  const voiceId = opts?.voiceId || env.ELEVENLABS_VOICE_ID;

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: text.trim().slice(0, 5000),
      model_id: 'eleven_multilingual_v2', // supporte le français nativement
      voice_settings: {
        stability: opts?.stability ?? 0.5,
        similarity_boost: opts?.similarityBoost ?? 0.75,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 400)}`, 502);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { audioBuffer: Buffer.from(arrayBuffer), contentType: 'audio/mpeg' };
}

/**
 * Estimation grossière de la durée d'un texte lu à voix haute (≈ 150 mots/min
 * en français, débit naturel de narration publicitaire). Utile pour calibrer
 * la longueur du script généré par Claude à la durée cible de la vidéo, avant
 * même d'appeler le TTS.
 */
export function estimateSpeechDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 60);
}
