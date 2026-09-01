import { Schema, model, Types } from 'mongoose';
import { SiteNiche } from './Site';

/**
 * ChatSession — le chat IA (Haiku) qui guide le client jusqu'au brief complet.
 *
 * Principe (voir discussion Partie D — chat guide) :
 *  - Haiku ne pilote QUE la conversation : à chaque tour il renvoie un message
 *    + un mode ('choices' | 'input'). Il n'écrit jamais lui-même le `brief`
 *    final envoyé au Codeur.
 *  - `collectedBrief` reste vide/partiel pendant toute la conversation. Il
 *    n'est rempli qu'une seule fois, à la fin, par un appel d'EXTRACTION
 *    séparé (voir chat.service.ts) qui relit tout `messages` d'un coup —
 *    plus fiable qu'une extraction incrémentale tour par tour.
 *  - `status`:
 *      'collecting'  → conversation en cours (niche pas encore fixée ou infos manquantes)
 *      'reviewing'   → extraction faite, récap présenté au client, en attente de confirmation
 *      'confirmed'   → client a validé le récap, Site créé (voir `siteId`)
 *      'abandoned'   → session inactive/abandonnée (nettoyage éventuel)
 */

export type ChatSessionStatus = 'collecting' | 'reviewing' | 'confirmed' | 'abandoned';
export type ChatMessageMode = 'choices' | 'input';
export type ChatMessageRole = 'assistant' | 'user';
/** Mode du hub chat : site | logo | edit | business (Coach) */
export type ChatHubMode = 'site' | 'logo' | 'edit' | 'business';

export interface IChatAttachment {
  url: string;
  /** 'image' | 'file' — jamais de vocal (voir Partie D — point 6) */
  type: 'image' | 'file';
  name?: string;
}

export interface IChatMessage {
  role: ChatMessageRole;
  content: string;
  /** Uniquement pour role='assistant' — pilote l'UI (voir chat.routes.ts) */
  mode?: ChatMessageMode;
  /** Uniquement si mode='choices' */
  options?: string[];
  /** Pièces jointes envoyées par le client (image/fichier) — jamais de vocal */
  attachments?: IChatAttachment[];
  createdAt: Date;
}

export interface IChatSession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: ChatSessionStatus;
  /** Mode hub : site (défaut) | logo | edit | business */
  mode: ChatHubMode;
  niche?: SiteNiche;
  messages: IChatMessage[];
  /** Rempli uniquement lors du passage collecting → reviewing (extraction finale) */
  collectedBrief: Record<string, unknown>;
  /** Récap en langage naturel généré par le backend à partir de collectedBrief, montré au client pour confirmation */
  reviewSummary?: string;
  /** Champs encore manquants après l'extraction — si non vide, on reste en 'collecting' */
  missingFields?: string[];
  siteId?: Types.ObjectId;
  /** Mode edit : site ciblé pour les modifications */
  editSiteId?: Types.ObjectId;
  /** Uniquement pour les sessions ouvertes depuis l'Espace Agence — le site sera rattaché à ce client */
  clientId?: Types.ObjectId;
  /** Relance différée (Pub 4) : email déjà envoyé pour cette session Coach business restée sans site — évite les doublons */
  reminderSent?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const chatMessageSchema = new Schema<IChatMessage>(
  {
    role: { type: String, enum: ['assistant', 'user'], required: true },
    content: { type: String, required: true },
    mode: { type: String, enum: ['choices', 'input'] },
    options: [{ type: String }],
    attachments: [
      {
        url: String,
        type: { type: String, enum: ['image', 'file'] },
        name: String,
        _id: false,
      },
    ],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const chatSessionSchema = new Schema<IChatSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['collecting', 'reviewing', 'confirmed', 'abandoned'],
      default: 'collecting',
    },
    mode: {
      type: String,
      enum: ['site', 'logo', 'edit', 'business'],
      default: 'site',
      index: true,
    },
    reminderSent: { type: Boolean, default: false },
    niche: {
      type: String,
      enum: [
        'hotellerie_evenementiel',
        'sante_bienetre',
        'immobilier_architecture',
        'services_locaux',
        'business_vitrine',
        'ecommerce_mode',
        'portfolio_creatif',
        'tech_startup_saas',
        'restaurant_gastronomie',
        'education_formation',
      ],
    },
    messages: { type: [chatMessageSchema], default: [] },
    collectedBrief: { type: Schema.Types.Mixed, default: {} },
    reviewSummary: { type: String },
    missingFields: [{ type: String }],
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    editSiteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client' },
  },
  { timestamps: true }
);

export const ChatSession = model<IChatSession>('ChatSession', chatSessionSchema);
