import { Schema, model, Types } from 'mongoose';

export type CreditTransactionType =
  | 'achat_pack'
  | 'achat_abonnement'
  | 'apercu_site'
  | 'generation_site'
  | 'logo'
  | 'modification_niveau2'
  | 'modification_niveau3'
  | 'redeploiement'
  | 'deblocage_boutique'
  | 'achat_domaine'
  | 'ajustement_admin'
  | 'video_ad'
  | 'video_ad_relance';

export interface ICreditTransaction {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: CreditTransactionType;
  amount: number; // négatif = dépense, positif = crédit
  balanceAfter: number;
  relatedSiteId?: Types.ObjectId;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const creditTransactionSchema = new Schema<ICreditTransaction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: [
        'achat_pack',
        'apercu_site',
        'generation_site',
        'logo',
        'modification_niveau2',
        'modification_niveau3',
        'redeploiement',
        'deblocage_boutique',
        'achat_domaine',
        'ajustement_admin',
        'video_ad',
        'video_ad_relance',
      ],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    relatedSiteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    note: { type: String },
  },
  { timestamps: true }
);

export const CreditTransaction = model<ICreditTransaction>('CreditTransaction', creditTransactionSchema);
