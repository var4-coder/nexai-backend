import { Schema, model, Types } from 'mongoose';

export type AcademyContentType = 'video' | 'pdf';
export type AcademyAccess = 'gratuit' | 'payant';
export type AcademyStatus = 'brouillon' | 'publié';

/**
 * Hébergement d'un contenu Académie :
 *  · cloudinary    : fichier sur Cloudinary (PDF, et vidéos envoyées avant Bunny)
 *  · bunny         : vidéo sur Bunny Stream (sourceUrl = GUID de la vidéo Bunny)
 *  · youtube       : vidéo YouTube intégrée via le lecteur officiel (sourceUrl = ID YouTube).
 *                    Règle YouTube : « must not charge users to watch content in an
 *                    embedded YouTube player » → JAMAIS verrouillée, ouverte à tous.
 *  · embed_externe : ancien format (URL d'intégration brute). Traité comme une
 *                    intégration externe : jamais verrouillé non plus.
 */
export type AcademyHosting = 'cloudinary' | 'bunny' | 'youtube' | 'embed_externe';

/**
 * Rôle d'un contenu dans son module :
 *  · seance : contenu de formation (PDF ou vidéo) ;
 *  · apercu : courte vidéo d'illustration, toujours ouverte (sert de vitrine
 *             à l'essai gratuit et de lien depuis les PDF / kits experts).
 */
export type AcademyRole = 'seance' | 'apercu';

/** Licence d'une vidéo reprise d'un tiers (catalogue Creative Commons ou fournisseur). */
export type AcademyLicence =
  | 'cc-by'
  | 'cc-by-sa'
  | 'cc-by-nd'
  | 'cc0'
  | 'domaine-public'
  | 'youtube-standard'
  | 'fournisseur'
  | 'nexai';

/**
 * Place d'une leçon dans sa formation (structure validée le 25/09/2026) :
 *  · bases    : Partie 1 « Les bases » (vidéo IA tirée du résumé)
 *  · complet  : Partie 2 — Comprendre (vidéo IA complète)
 *  · pratique : Partie 2 — Phase pratique (vidéos réelles ou IA)
 *  · kit      : Partie 2 — Kit Expert (PDF téléchargeable, filigrane)
 * Un contenu sans partie n'est jamais montré au client (ancien contenu à classer).
 */
export type AcademyPartie = 'bases' | 'complet' | 'pratique' | 'kit';

/**
 * Nature d'une leçon :
 *  · ia          : vidéo IA générée depuis un PDF (générateur NexAI)
 *  · pratique_ia : cas pratique guidé généré par IA
 *  · reelle      : vraie vidéo de formateur (PeerTube, Profitdigit, fournisseur sous licence)
 *  · document    : PDF (kit)
 */
export type AcademyGenre = 'ia' | 'pratique_ia' | 'reelle' | 'document';

export interface IAcademyAttribution {
  licence: AcademyLicence;
  /** Nom de l'auteur ou de la chaîne d'origine — crédit obligatoire en CC */
  auteur?: string;
  /** Titre original de l'œuvre */
  titreOriginal?: string;
  /** URL de la vidéo d'origine */
  sourceUrl?: string;
  /** Plateforme d'origine (YouTube, PeerTube…) ou nom du fournisseur */
  plateforme?: string;
}

export interface IAcademyContent {
  _id: Types.ObjectId;
  title: string;
  type: AcademyContentType;
  access: AcademyAccess;
  creditsCost?: number; // requis si access = 'payant'
  /**
   * brouillon = créé automatiquement (upload admin) mais invisible côté
   * client — publié = validé manuellement par l'admin, visible côté client.
   * Toutes les routes client (GET /academy, GET /academy/:id) filtrent sur
   * status='publié' uniquement.
   */
  status: AcademyStatus;
  /** Niche utilisée pour la recherche d'image Pexels + le prompt Sonnet 5 */
  niche?: string;
  /** Image de couverture trouvée automatiquement via Pexels (niche + titre) */
  imageUrl?: string;
  // hosting = 'cloudinary' : sourceUrl est un public_id Cloudinary (ressource "authenticated"),
  //   servi via /academy/:id/stream ou /video-stream avec token signé courte durée — jamais d'URL directe.
  // hosting = 'bunny' : sourceUrl est le GUID Bunny Stream — lu via un lien de lecture signé (token + expiration).
  // hosting = 'youtube' : sourceUrl est l'ID YouTube (11 caractères) — lecteur officiel, toujours ouvert.
  // hosting = 'embed_externe' : ancien format, URL d'intégration brute (vidéo uniquement).
  hosting: AcademyHosting;
  // PDF : viewer intégré, jamais de téléchargement direct, URL jamais exposée directement
  sourceUrl: string;
  /**
   * Pack auquel ce contenu appartient. Absent = contenu autonome, affiché
   * seul dans l'Académie.
   */
  packId?: Types.ObjectId;
  category?: string;
  /** Groupement par formation (frontend regroupe PDF / Vidéos par formation) */
  formationId?: string;
  formationTitle?: string;
  description?: string;
  /** Module de l'Académie (slug de data/academy-modules.ts) */
  module?: string;
  /** Ordre d'affichage dans sa formation (numéro de séance) */
  ordre?: number;
  role: AcademyRole;
  /** Durée en secondes (vidéos) */
  duree?: number;
  /** Crédit de l'œuvre d'origine (obligatoire pour une licence Creative Commons) */
  attribution?: IAcademyAttribution;
  partie?: AcademyPartie;
  genre?: AcademyGenre;
  /** Fournisseur / licence (ex. « Profitdigit », « PeerTube — Jean Dupont ») — suivi des droits */
  fournisseur?: string;
  /** Dernier contrôle de disponibilité (vidéos YouTube intégrées) */
  verificationLien?: { ok: boolean; raison?: string; verifieLe: Date };
  createdAt: Date;
  updatedAt: Date;
}

const academyContentSchema = new Schema<IAcademyContent>(
  {
    title: { type: String, required: true },
    type: { type: String, enum: ['video', 'pdf'], required: true },
    access: { type: String, enum: ['gratuit', 'payant'], required: true },
    creditsCost: { type: Number, min: 0 },
    status: { type: String, enum: ['brouillon', 'publié'], required: true, default: 'brouillon', index: true },
    niche: { type: String },
    imageUrl: { type: String },
    hosting: {
      type: String,
      enum: ['cloudinary', 'bunny', 'youtube', 'embed_externe'],
      required: true,
      default: 'cloudinary',
    },
    sourceUrl: { type: String, required: true, select: false }, // jamais exposée directement au client
    packId: { type: Schema.Types.ObjectId, ref: 'AcademyPack', index: true },
    category: { type: String },
    formationId: { type: String, index: true },
    formationTitle: { type: String },
    description: { type: String },
    module: { type: String, index: true },
    ordre: { type: Number, default: 0 },
    role: { type: String, enum: ['seance', 'apercu'], default: 'seance' },
    partie: { type: String, enum: ['bases', 'complet', 'pratique', 'kit'], index: true },
    genre: { type: String, enum: ['ia', 'pratique_ia', 'reelle', 'document'] },
    fournisseur: { type: String, trim: true, maxlength: 200 },
    duree: { type: Number, min: 0 },
    attribution: {
      licence: {
        type: String,
        enum: ['cc-by', 'cc-by-sa', 'cc-by-nd', 'cc0', 'domaine-public', 'youtube-standard', 'fournisseur', 'nexai'],
      },
      auteur: { type: String },
      titreOriginal: { type: String },
      sourceUrl: { type: String },
      plateforme: { type: String },
    },
    verificationLien: {
      ok: { type: Boolean },
      raison: { type: String },
      verifieLe: { type: Date },
    },
  },
  { timestamps: true }
);

academyContentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const AcademyContent = model<IAcademyContent>('AcademyContent', academyContentSchema);
