import { Schema, model, Types } from 'mongoose';

/**
 * Déblocage d'un PACK payant de la Boutique (décision du 03/10/2026) :
 * un contenu payant se débloque AVANT d'entrer et d'en voir le contenu.
 * Un pack débloqué donne accès à tous ses produits, sans autre paiement.
 */
export interface IPackPurchase {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  packId: Types.ObjectId;
  creditsSpent: number;
  createdAt: Date;
}

const schema = new Schema<IPackPurchase>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packId: { type: Schema.Types.ObjectId, ref: 'BoutiquePack', required: true },
    creditsSpent: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ userId: 1, packId: 1 }, { unique: true });

export const PackPurchase = model<IPackPurchase>('PackPurchase', schema);
