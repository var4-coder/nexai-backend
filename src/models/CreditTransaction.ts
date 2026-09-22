import { Schema, model, Types } from 'mongoose';

export type CreditTransactionType =
  | 'achat_pack'
  /** Achat/upgrade d'abonnement confirmé par le webhook Chariow (donne droit à un reçu) */
  | 'achat_abonnement'
  | 'apercu_site'
  | 'generation_site'
  | 'logo'
  /** Coach « Trouver un business » — 3 crédits, 1 idée par session */
  | 'coach_business'
  | 'modification_niveau2'
  | 'modification_niveau3'
  | 'redeploiement'
  | 'deblocage_boutique'
  | 'achat_domaine'
  | 'ajustement_admin'
  | 'video_ad'
  | 'video_ad_relance'
  /**
   * Hébergement seul, payé par un compte SANS abonnement actif pour garder
   * son site en ligne au-delà du quota gratuit. Seul débit autorisé à un
   * abonné expiré.
   */
  | 'hebergement_seul';

export interface ICreditTransaction {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: CreditTransactionType;
  amount: number; // négatif = dépense, positif = crédit
  balanceAfter: number;
  relatedSiteId?: Types.ObjectId;
  /** Montant réellement payé en FCFA — requis pour générer un reçu (section 17) */
  montantFcfa?: number;
  /** Référence du paiement chez le prestataire (Chariow…) */
  referencePaiement?: string;
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
        'achat_abonnement',
        'apercu_site',
        'generation_site',
        'logo',
        'coach_business',
        'modification_niveau2',
        'modification_niveau3',
        'redeploiement',
        'deblocage_boutique',
        'achat_domaine',
        'ajustement_admin',
        'video_ad',
        'video_ad_relance',
        'hebergement_seul',
      ],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    relatedSiteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    montantFcfa: { type: Number },
    referencePaiement: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

export const CreditTransaction = model<ICreditTransaction>('CreditTransaction', creditTransactionSchema);
