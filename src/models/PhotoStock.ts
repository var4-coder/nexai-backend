import { Schema, model, Types } from 'mongoose';

/**
 * Stock de photos par niche (création de site). Chaque photo vient de Pexels mais est COPIÉE dans le
 * Cloudinary NexAI : les sites livrés pointent vers notre stockage, jamais vers un lien Pexels qui peut
 * expirer. On garde photographe + lien Pexels pour le crédit dans le site.
 */
export interface IPhotoStock {
  _id: Types.ObjectId;
  niche: string;
  pexelsId: number;
  url: string; // URL Cloudinary optimisée (f_auto,q_auto)
  publicId: string;
  photographer: string;
  pexelsUrl: string;
  width: number;
  height: number;
  requete: string;
  /** Description Pexels, couleur moyenne et photographe : filtres et cohérence d'une série (MEDIA.md). */
  alt?: string;
  avgColor?: string;
  photographerId?: number;
  /** Netteté mesurée (variance du Laplacien), si la mesure est activée. */
  nettete?: number;
  /** Orientation de la photo (absente = paysage, photos d'avant le 02/10/2026). */
  orientation?: 'paysage' | 'portrait';
  statut: 'disponible' | 'attribuee';
  siteId?: Types.ObjectId;
  attribueeLe?: Date;
}

const schema = new Schema<IPhotoStock>(
  {
    niche: { type: String, required: true, index: true },
    pexelsId: { type: Number, required: true, unique: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    photographer: { type: String, default: '' },
    pexelsUrl: { type: String, default: 'https://www.pexels.com' },
    width: Number,
    height: Number,
    requete: String,
    alt: String,
    avgColor: String,
    photographerId: Number,
    nettete: Number,
    orientation: { type: String, enum: ['paysage', 'portrait'] },
    statut: { type: String, enum: ['disponible', 'attribuee'], default: 'disponible', index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    attribueeLe: Date,
  },
  { timestamps: true }
);
schema.index({ niche: 1, statut: 1 });

export const PhotoStock = model<IPhotoStock>('PhotoStock', schema);
