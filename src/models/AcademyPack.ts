import { Schema, model, Types } from 'mongoose';

/**
 * Packs de l'Académie NexAI.
 *
 * Un pack regroupe plusieurs contenus (PDF, vidéos) présentés au client
 * comme un ensemble cohérent — une formation complète plutôt qu'une liste
 * de fichiers épars. Le client voit d'abord la carte du pack, puis les
 * contenus qu'il renferme.
 *
 * L'Académie accepte les deux formes :
 *  - un contenu SEUL (AcademyContent sans packId) : affiché tel quel ;
 *  - un PACK (AcademyContent avec packId) : les contenus sont regroupés
 *    sous une même carte.
 *
 * L'administrateur crée, renomme et supprime les packs librement : rien
 * n'est figé dans le code, le nombre de packs n'est pas limité.
 */
export interface IAcademyPack {
  _id: Types.ObjectId;
  titre: string;
  /** Accroche affichée sur la carte, ex. « Formation complète en 12 modules » */
  sousTitre?: string;
  description?: string;
  /** Prix du pack entier, en crédits. 0 = pack gratuit. */
  creditsCost: number;
  /** gratuit : accessible à tous les abonnés ; payant : débité en crédits. */
  access: 'gratuit' | 'payant';
  /** Position d'affichage (les packs sont rangés par ordre croissant) */
  ordre: number;
  /** Illustration de la carte (Pexels ou upload admin) */
  imageUrl?: string;
  /** Catégorie / niche, pour le classement côté client (ancien champ) */
  category?: string;
  /**
   * Module de l'Académie auquel appartient cette formation (slug de
   * data/academy-modules.ts). Un pack = une FORMATION ; ses contenus = ses séances.
   */
  module?: string;
  /** Identifiant de la formation au programme (data/academy-modules.ts) */
  slug?: string;
  /** Phrase d'accroche de la carte formation */
  accroche?: string;
  /** Ce que la pratique apporte — texte de vente de la Partie 2 */
  pratique?: string;
  /** Crédit de la photo Pexels */
  imagePhotographe?: string;
  /** Un pack en brouillon n'est jamais visible côté client */
  status: 'brouillon' | 'publié';
  createdAt: Date;
  updatedAt: Date;
}

const academyPackSchema = new Schema<IAcademyPack>(
  {
    titre: { type: String, required: true, trim: true },
    sousTitre: { type: String, trim: true },
    description: { type: String },
    creditsCost: { type: Number, required: true, min: 0, default: 0 },
    access: { type: String, enum: ['gratuit', 'payant'], default: 'gratuit' },
    ordre: { type: Number, default: 0, index: true },
    imageUrl: { type: String },
    category: { type: String },
    module: { type: String, index: true },
    slug: { type: String, index: { unique: true, sparse: true } },
    accroche: { type: String },
    pratique: { type: String },
    imagePhotographe: { type: String },
    status: {
      type: String,
      enum: ['brouillon', 'publié'],
      default: 'brouillon',
      index: true,
    },
  },
  { timestamps: true }
);

export const AcademyPack = model<IAcademyPack>('AcademyPack', academyPackSchema);
