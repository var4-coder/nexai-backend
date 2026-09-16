import { Schema, model, Types } from 'mongoose';

export type BoutiqueAudience = 'starter_formation' | 'all_paid' | 'everyone';
/** Type de fichier du produit — détermine le resource_type Cloudinary utilisé pour le téléchargement signé */
/**
 * Boutique : PDF uniquement côté client (décision produit — les vidéos
 * restent à l'Académie). 'archive' sert aux lots ZIP importés par l'admin,
 * qui sont décompressés en PDF individuels.
 */
export type BoutiqueProductType = 'pdf' | 'archive';
export type BoutiqueStatus = 'brouillon' | 'publié';

export interface IBoutiqueProduct {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  isFreeForSubscriber: boolean; // gratuit pour abonné, sinon coût en crédits
  /** Pack auquel ce produit appartient. Obligatoire : la Boutique
   *  s'organise par packs, jamais en liste d'articles isolés. */
  packId?: Types.ObjectId;
  creditsCost: number;
  /** starter_formation = visible Starter only (apprendre/business). all_paid = Créateur+. everyone = tous abonnés */
  audience: BoutiqueAudience;
  /** pdf/archive → Cloudinary resource_type 'raw', video → 'video', image → 'image' (voir cloudinary.service.ts) */
  type: BoutiqueProductType;
  cloudinaryPublicId: string; // utilisé pour générer une signed URL au déblocage
  /**
   * brouillon = créé automatiquement (upload admin, titre-accroche +
   * description générés par Sonnet 5) mais invisible côté client — publié
   * = validé manuellement par l'admin. GET /boutique filtre sur 'publié'.
   */
  status: BoutiqueStatus;
  /** Niche utilisée pour la recherche d'image Pexels + le prompt Sonnet 5 */
  niche?: string;
  /** Image de couverture trouvée automatiquement via Pexels */
  imageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const boutiqueProductSchema = new Schema<IBoutiqueProduct>(
  {
    packId: { type: Schema.Types.ObjectId, ref: 'BoutiquePack', index: true },
    title: { type: String, required: true },
    description: { type: String },
    isFreeForSubscriber: { type: Boolean, default: false },
    audience: { type: String, enum: ['starter_formation', 'all_paid', 'everyone'], default: 'all_paid' },
    creditsCost: { type: Number, default: 0, min: 0 },
    type: { type: String, enum: ['pdf', 'video', 'image', 'archive'], default: 'pdf' },
    cloudinaryPublicId: { type: String, required: true },
    status: { type: String, enum: ['brouillon', 'publié'], required: true, default: 'brouillon', index: true },
    niche: { type: String },
    imageUrl: { type: String },
  },
  { timestamps: true }
);

export const BoutiqueProduct = model<IBoutiqueProduct>('BoutiqueProduct', boutiqueProductSchema);

