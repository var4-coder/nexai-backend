import 'dotenv/config';
import { z } from 'zod';

/**
 * Toutes les variables d'environnement du backend plateforme NexAI sont
 * validées ici au démarrage. Si une variable requise manque, le process
 * s'arrête immédiatement avec un message clair plutôt que de planter plus
 * tard au premier appel (fail-fast).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().url().default('http://localhost:3000'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI est requis'),
  REDIS_URL: z.string().min(1, 'REDIS_URL est requis'),

  JWT_SECRET: z.string().min(1, 'JWT_SECRET est requis'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),

  BREVO_API_KEY: z.string().optional().default(''),
  BREVO_SENDER_EMAIL: z.string().optional().default('no-reply@nexai.app'),
  BREVO_SENDER_NAME: z.string().optional().default('NexAI'),

  CHARIOW_WEBHOOK_SECRET: z.string().optional().default(''),
  CHARIOW_API_KEY: z.string().optional().default(''),

  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),

  NETLIFY_ACCESS_TOKEN: z.string().optional().default(''),
  GODADDY_API_KEY: z.string().optional().default(''),
  GODADDY_API_SECRET: z.string().optional().default(''),

  /** URL publique de l'API NexAI, utilisée dans le HTML/JS ou les projets Next.js
   *  générés pour les sites clients, afin qu'ils puissent poster leurs formulaires
   *  vers /api/v1/public (voir routes/public.routes.ts). */
  PUBLIC_API_BASE_URL: z.string().optional().default('http://localhost:4000'),

  RECRAFT_API_KEY: z.string().optional().default(''),
  ALEXYA_API_KEY: z.string().optional().default(''),
  PEXELS_API_KEY: z.string().optional().default(''),

  XAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),

  // ── Vidéo IA — Option 2 "Avatar" (Mode Standard + Mode Scénario) ──
  // FalAI héberge Kling AI Avatar v2 (Standard $0.0562/s, Pro $0.115/s pour le
  // Mode Scénario). Un seul appel FalAI est plafonné à 60s d'audio (contrainte
  // Kling) : le Mode Scénario (120s) chaîne donc 2 appels Pro de 60s, concaténés
  // via ffmpeg comme pour les clips Alexya.
  FALAI_API_KEY: z.string().optional().default(''),
  // TTS voix off (Option 1 "voix off + musique" ET script du Mode Scénario/Avatar).
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_VOICE_ID: z.string().optional().default('21m00Tcm4TlvDq8ikWAM'), // "Rachel", voix par défaut / fallback
  // Pool de voix pour varier la narration entre clients (Option 1 "voix off") —
  // une voix est tirée au sort par vidéo au lieu de toujours réutiliser
  // ELEVENLABS_VOICE_ID. Format : IDs ElevenLabs séparés par des virgules.
  // Mix par défaut : Rachel/Bella/Elli (voix féminines) + Antoni/Josh/Adam
  // (voix masculines), toutes compatibles eleven_multilingual_v2 (français).
  ELEVENLABS_VOICE_IDS: z
    .string()
    .optional()
    .default(
      '21m00Tcm4TlvDq8ikWAM,EXAVITQu4vr4xnSDxMaL,MF3mGyEYCl7XYWbV9V6O,ErXwobaYiN019PkySvjV,TxGEqnHWrfWFTfGW9XjX,pNInz6obpgDQGcFmaJgB'
    ),

  ADMIN_EMAIL: z.string().email().default('vermechat@gmail.com'),

  // ── Vidéo pub — tier Standard (silencieux + musique + overlay) et musique
  // de fond du tier "avec_son". Les URLs des tracks (pool par niche, Cloudinary)
  // sont désormais hardcodées dans src/data/library/musicTracks.ts — plus besoin
  // de variables d'env par niche ici.
  // Volume de la musique de fond (0 à 1). 0.8 par défaut : présente mais ne couvre pas le texte.
  MUSIC_VOLUME: z.coerce.number().min(0).max(1).default(0.8),
  // Volume de la musique de fond sous une voix off (tier "avec_son") : nettement plus bas
  // pour ne jamais couvrir la narration. 0.18 par défaut (~ -15dB sous la voix).
  MUSIC_VOLUME_PRO: z.coerce.number().min(0).max(1).default(0.18),
  // Police utilisée pour le texte incrusté (drawtext ffmpeg). DejaVu est présente par défaut sur Ubuntu.
  FFMPEG_FONT_PATH: z.string().optional().default('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variables d\'environnement invalides :');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
