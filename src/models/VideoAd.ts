import { Schema, model, Types } from 'mongoose';
import { VideoAdFormat, VideoAdMode, VideoAdQuality } from '@/services/credits.service';

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
  /** Identifiant Cloudinary du plan archivé, nécessaire pour le supprimer. */
  clipPublicId?: string;
  retried?: boolean;
  error?: string;
  source?: 'ai' | 'capture'; // 'capture' = plan issu de la capture réelle du site (Playwright)
  /** Image de référence (image-to-image Grok Imagine) utilisée pour ce plan IA, si disponible. */
  referenceImageUrl?: string;
  /** 'product' = vraie photo produit (site scrappé ou upload client) ; 'mockup' = photo stock Pexels (réutilisée ou nouvelle). */
  referenceImageKind?: 'product' | 'mockup';
  /**
   * Moteur vidéo qui a réellement produit ce clip.
   *
   * Tracé pour le support client et le suivi des coûts : Premium et Standard
   * utilisent deux fournisseurs différents (Kling V3 Pro / Alexya "best") aux
   * tarifs distincts. Toutes les scènes d'une même vidéo portent forcément la
   * même valeur — les deux moteurs ne se mélangent jamais dans une vidéo.
   */
  engine?: 'kling_v3_pro' | 'alexya_best';
}

export interface IVideoAd {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  siteId?: Types.ObjectId; // optionnel — vidéo peut être personnalisée via URL externe
  mode: VideoAdMode; // 'voix_off' | 'avatar_pub' | 'mini_film'
  format: VideoAdFormat; // '30s' | '60s' | '120s' (mini_film : 120s uniquement)
  quality: VideoAdQuality; // 'standard' | 'premium' — Premium = ×2 crédits, tous modes
  aspectRatio: '16:9' | '9:16';
  brief: Record<string, unknown>;
  creditsCharged: number;
  status: VideoAdStatus;
  scenes: IVideoAdScene[];
  // ── Champs spécifiques Avatar (avatar_pub / mini_film) ──
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
  /**
   * Renseigné quand la vidéo a été livrée INCOMPLÈTE : certains plans n'ont
   * pas pu être générés, mais assez ont abouti pour produire une vidéo
   * exploitable. Mieux vaut livrer une pub un peu plus courte que de tout
   * jeter — les plans réussis ont déjà été payés au fournisseur.
   */
  partialDelivery?: {
    scenesGenerated: number;
    scenesFailed: number;
    reason?: string;
  };
  /**
   * Nombre de relances PARTIELLES déjà consommées dans cette chaîne de
   * relances (plafonné, voir MAX_PARTIAL_RELAUNCHES_PAR_FORMAT).
   *
   * Suit la chaîne et non la vidéo isolée : chaque relance recopie le compteur
   * incrémenté, sinon le plafond serait remis à zéro à chaque tentative.
   */
  partialRelaunchCount?: number;
  /** Renseigné sur la NOUVELLE vidéo créée par une relance corrective — référence la vidéo d'origine. */
  isRelaunchOf?: Types.ObjectId;
  /**
   * Publication dans la galerie d'exemples, visible par tous les visiteurs.
   *
   * Seul l'administrateur peut y placer une vidéo : ce sont de vraies
   * productions NexAI, générées normalement, puis choisies comme vitrine.
   * Le visiteur juge ainsi la qualité réelle de ce qu'il achètera.
   */
  /**
   * Vidéo due au client sans qu'il l'ait payée sur cette commande précise :
   * cadeau de bienvenue, ou relance gratuite d'une vidéo payée.
   *
   * creditsCharged vaut alors 0 — la comptabilité reste juste — mais la
   * vidéo ouvre quand même droit à la relance gratuite si elle échoue. Sans
   * ce marqueur, un client dont la première relance échoue aussi se verrait
   * refuser toute nouvelle tentative, alors qu'il a bien payé au départ.
   */
  offerte?: boolean;
  /**
   * Nombre de relances gratuites DÉJÀ tentées dans cette chaîne, après un
   * échec total. Sert à imposer une pause : deux tentatives immédiates sont
   * permises — un incident passager se règle souvent au deuxième essai —
   * puis le bouton se verrouille le temps qu'une vraie panne se rétablisse.
   */
  echecRelanceCount?: number;
  galerie?: {
    publie: boolean;
    titre: string;
    description?: string;
    /** Ordre d'affichage, croissant. */
    ordre: number;
    /** « exemple » : vidéo client type · « presentation » : vidéo qui présente NexAI */
    categorie: 'exemple' | 'presentation';
  };
  /**
   * Horodatage du dernier échec définitif (rien livré).
   *
   * Sert de point de départ au délai d'attente avant relance gratuite : sans
   * délai, un client relancerait en boucle pendant une panne fournisseur et
   * chaque tentative échouerait pour la même raison. Voir
   * FREE_RELAUNCH_COOLDOWN_MS dans video-ads.routes.ts.
   */
  failedAt?: Date;
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
    clipPublicId: { type: String },
    retried: { type: Boolean, default: false },
    error: { type: String },
    source: { type: String, enum: ['ai', 'capture'] },
    referenceImageUrl: { type: String },
    referenceImageKind: { type: String, enum: ['product', 'mockup'] },
    engine: { type: String, enum: ['kling_v3_pro', 'alexya_best'] },
  },
  { _id: false }
);

const videoAdSchema = new Schema<IVideoAd>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: false, index: true },
    mode: {
      type: String,
      enum: ['voix_off', 'avatar_pub', 'mini_film'],
      required: true,
      default: 'voix_off',
    },
    format: { type: String, enum: ['30s', '60s', '120s'], required: true },
    quality: { type: String, enum: ['standard', 'premium'], required: true, default: 'standard' },
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
    partialDelivery: {
      scenesGenerated: { type: Number },
      scenesFailed: { type: Number },
      reason: { type: String },
    },
    partialRelaunchCount: { type: Number, default: 0, min: 0 },
    isRelaunchOf: { type: Schema.Types.ObjectId, ref: 'VideoAd' },
    offerte: { type: Boolean, default: false },
    echecRelanceCount: { type: Number, default: 0 },
    galerie: {
      publie: { type: Boolean, default: false, index: true },
      titre: { type: String, maxlength: 120 },
      description: { type: String, maxlength: 400 },
      ordre: { type: Number, default: 0 },
      categorie: { type: String, enum: ['exemple', 'presentation'], default: 'exemple' },
    },
    failedAt: { type: Date },
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
