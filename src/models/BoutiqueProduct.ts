import { Schema, model, Types } from 'mongoose';

export type BoutiqueAudience = 'starter_formation' | 'all_paid' | 'everyone';
/** Type de fichier du produit — détermine le resource_type Cloudinary utilisé pour le téléchargement signé */
export type BoutiqueProductType = 'pdf' | 'video' | 'image' | 'archive';

export interface IBoutiqueProduct {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  isFreeForSubscriber: boolean; // gratuit pour abonné, sinon coût en crédits
  creditsCost: number;
  /** starter_formation = visible Starter only (apprendre/business). all_paid = Créateur+. everyone = tous abonnés */
  audience: BoutiqueAudience;
  /** pdf/archive → Cloudinary resource_type 'raw', video → 'video', image → 'image' (voir cloudinary.service.ts) */
  type: BoutiqueProductType;
  cloudinaryPublicId: string; // utilisé pour générer une signed URL au déblocage
  createdAt: Date;
  updatedAt: Date;
}

const boutiqueProductSchema = new Schema<IBoutiqueProduct>(
  {
    title: { type: String, required: true },
    description: { type: String },
    isFreeForSubscriber: { type: Boolean, default: false },
    audience: { type: String, enum: ['starter_formation', 'all_paid', 'everyone'], default: 'all_paid' },
    creditsCost: { type: Number, default: 0, min: 0 },
    type: { type: String, enum: ['pdf', 'video', 'image', 'archive'], default: 'pdf' },
    cloudinaryPublicId: { type: String, required: true },
  },
  { timestamps: true }
);

export const BoutiqueProduct = model<IBoutiqueProduct>('BoutiqueProduct', boutiqueProductSchema);

