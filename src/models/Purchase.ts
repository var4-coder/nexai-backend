import { Schema, model, Types } from 'mongoose';

export interface IPurchase {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  productId: Types.ObjectId;
  creditsSpent: number;
  unlockedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const purchaseSchema = new Schema<IPurchase>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'BoutiqueProduct', required: true },
    creditsSpent: { type: Number, required: true, min: 0 },
    unlockedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

purchaseSchema.index({ userId: 1, productId: 1 }, { unique: true });

export const Purchase = model<IPurchase>('Purchase', purchaseSchema);
