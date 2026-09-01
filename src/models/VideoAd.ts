import { Schema, model, Types } from 'mongoose';
import { VideoAdFormat, VideoAdMode } from '@/services/credits.service';

export type VideoAdStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'refunded';

export interface IVideoAdScene {
  index: number;
  prompt: string;
  durationSeconds: number;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  clipUrl?: string;
  retried?: boolean;
  error?: string;
  source?: 'ai' | 'capture'; // 'capture' = plan issu de la capture réelle du site (Playwright)
  /** Image de référence (image-to-image Grok Imagine) utilisée pour ce plan IA, si disponible. */
  referenceImageUrl?: string;
  /** 'product' = vraie photo produit (site scrappé ou upload client) ; 'mockup' = photo stock Pexels (réutilisée ou nouvelle). */
  referenceImageKind?: 'product' | 'mockup';
}

export interface IVideoAd {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  siteId?: Types.ObjectId; // optionnel — vidéo peut être personnalisée via URL externe
  mode: VideoAdMode; // 'voix_off' | 'avatar_standard' | 'avatar_scenario'
  format: VideoAdFormat; // '30s' | '60s' | '120s' (selon le mode, voir credits.service)
  aspectRatio: '16:9' | '9:16';
  brief: Record<string, unknown>;
  creditsCharged: number;
  status: VideoAdStatus;
  scenes: IVideoAdScene[];
  // ── Champs spécifiques Avatar (avatar_standard / avatar_scenario) ──
  narrationScript?: string; // texte généré par Claude, lu par le TTS
  narrationAudioUrl?: string; // sortie ElevenLabs
  voiceId?: string; // voix ElevenLabs tirée au sort pour cette vidéo (Option 1 voix off)
  characterImageUrl?: string; // portrait du présentateur (Grok Imagine), réutilisable
  // ── Logo utilisé en intro de la vidéo (Option 1 voix off) ──
  logoUrl?: string;
  logoSource?: 'site' | 'generated'; // 'site' = extrait du vrai site, 'generated' = fallback IA (Recraft)
  // ── Pool d'images de référence (produits réels + mockups) résolu au début
  // du pipeline (voir product-image-sourcing.service.ts) — stocké pour
  // traçabilité/QA, pas relu pendant le montage.
  imageSourcing?: {
    productImagesCount: number;
    mockupImagesCount: number;
    mockupReused: boolean; // true si mockups réutilisés d'un site NexAI existant (pas de nouvel appel Pexels)
  };
  finalVideoUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
  // ── Contrôle qualité automatique (video-qc.service.ts), exécuté juste avant
  // de marquer la vidéo "completed" — traçabilité du fichier réellement livré.
  qcReport?: {
    durationSeconds?: number;
    width?: number | null;
    height?: number | null;
    audioMeanVolumeDb?: number;
    checkedAt?: Date;
    /** true si des défauts mineurs (non bloquants) ont été détectés — vidéo livrée quand même. */
    degraded?: boolean;
    /** Description des défauts mineurs détectés (voir video-qc.service.ts). Vide si vidéo propre. */
    minorIssues?: string[];
  };
  // ── Relance corrective (voir video-pipeline.service.ts /
  // video-ads.routes.ts) — proposée uniquement quand qcReport.degraded=true.
  relaunchOffer?: {
    eligible: boolean;
    used: boolean;
    /** Coût en crédits de la relance : 50% du prix payé si 1ère relance de cette vidéo, prix plein sinon. */
    priceCredits: number;
  };
  /** Renseigné sur la NOUVELLE vidéo créée par une relance corrective — référence la vidéo d'origine. */
  isRelaunchOf?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const videoAdSceneSchema = new Schema<IVideoAdScene>(
  {
    index: { type: Number, required: true },
    prompt: { type: String, required: true },
    durationSeconds: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'generating', 'completed', 'failed'],
      default: 'pending',
    },
    clipUrl: { type: String },
    retried: { type: Boolean, default: false },
    error: { type: String },
    source: { type: String, enum: ['ai', 'capture'] },
    referenceImageUrl: { type: String },
    referenceImageKind: { type: String, enum: ['product', 'mockup'] },
  },
  { _id: false }
);

const videoAdSchema = new Schema<IVideoAd>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: false, index: true },
    mode: {
      type: String,
      enum: ['voix_off', 'avatar_standard', 'avatar_scenario'],
      required: true,
      default: 'voix_off',
    },
    format: { type: String, enum: ['30s', '60s', '120s'], required: true },
    aspectRatio: { type: String, enum: ['16:9', '9:16'], default: '16:9' },
    brief: { type: Schema.Types.Mixed, default: {} },
    creditsCharged: { type: Number, required: true },
    status: {
      type: String,
      enum: ['queued', 'generating', 'completed', 'failed', 'refunded'],
      default: 'queued',
    },
    scenes: [videoAdSceneSchema],
    narrationScript: { type: String },
    narrationAudioUrl: { type: String },
    voiceId: { type: String },
    characterImageUrl: { type: String },
    logoUrl: { type: String },
    logoSource: { type: String, enum: ['site', 'generated'] },
    imageSourcing: {
      productImagesCount: { type: Number },
      mockupImagesCount: { type: Number },
      mockupReused: { type: Boolean },
    },
    finalVideoUrl: { type: String },
    thumbnailUrl: { type: String },
    errorMessage: { type: String },
    qcReport: {
      durationSeconds: { type: Number },
      width: { type: Number },
      height: { type: Number },
      audioMeanVolumeDb: { type: Number },
      checkedAt: { type: Date },
      degraded: { type: Boolean, default: false },
      minorIssues: [{ type: String }],
    },
    relaunchOffer: {
      eligible: { type: Boolean, default: false },
      used: { type: Boolean, default: false },
      priceCredits: { type: Number },
    },
    isRelaunchOf: { type: Schema.Types.ObjectId, ref: 'VideoAd' },
  },
  { timestamps: true }
);

videoAdSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const VideoAd = model<IVideoAd>('VideoAd', videoAdSchema);
