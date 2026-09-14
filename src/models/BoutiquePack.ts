import { Schema, model, Types } from 'mongoose';

/**
 * Packs de la Boutique NexAI.
 *
 * La Boutique n'est pas une liste d'articles en vrac : le client voit
 * d'abord des PACKS (cartes cliquables, sur le modèle des options de
 * NexAI Web), puis les produits contenus dans le pack choisi.
 *
 * Exemples voulus : « Pack 1 — plus de 200 produits digitaux avec droit
 * de revente », jusqu'à 5 packs payants pour environ 1000 produits, plus
 * un pack gratuit.
 *
 * L'administrateur crée, renomme et supprime les packs librement : rien
 * n'est figé dans le code, le nombre de packs n'est pas limité.
 */
export interface IBoutiquePack {
  _id: Types.ObjectId;
  titre: string;
  /** Accroche affichée sur la carte, ex. « Plus de 200 produits digitaux » */
  sousTitre?: string;
  description?: string;
  /** Prix du pack entier, en crédits. 0 = pack gratuit. */
  creditsCost: number;
  /** Position d'affichage (les packs sont rangés par ordre croissant) */
  ordre: number;
  /** Illustration de la carte (Pexels ou upload admin) */
  imageUrl?: string;
  /** Un pack en brouillon n'est jamais visible côté client */
  status: 'brouillon' | 'publié';
  createdAt: Date;
  updatedAt: Date;
}

const boutiquePackSchema = new Schema<IBoutiquePack>(
  {
    titre: { type: String, required: true, trim: true },
    sousTitre: { type: String, trim: true },
    description: { type: String },
    creditsCost: { type: Number, required: true, min: 0, default: 0 },
    ordre: { type: Number, default: 0, index: true },
    imageUrl: { type: String },
    status: {
      type: String,
      enum: ['brouillon', 'publié'],
      default: 'brouillon',
      index: true,
    },
  },
  { timestamps: true }
);

boutiquePackSchema.index({ status: 1, ordre: 1 });

export const BoutiquePack = model<IBoutiquePack>('BoutiquePack', boutiquePackSchema);
