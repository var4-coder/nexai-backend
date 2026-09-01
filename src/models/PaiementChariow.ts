import { Schema, model, Types } from 'mongoose';

export type StatutPaiement = 'en_attente' | 'valide_a_payer' | 'paye';

export interface IPaiementChariow {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  referenceChariow: string;
  montant: number;
  statut: StatutPaiement;
  compteReversement?: string;
  commissionNexai: number;
  webhookReceivedAt: Date;
  payeAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const paiementChariowSchema = new Schema<IPaiementChariow>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    referenceChariow: { type: String, required: true, unique: true },
    montant: { type: Number, required: true },
    statut: { type: String, enum: ['en_attente', 'valide_a_payer', 'paye'], default: 'en_attente' },
    compteReversement: { type: String },
    commissionNexai: { type: Number, required: true },
    webhookReceivedAt: { type: Date, default: () => new Date() },
    payeAt: { type: Date },
  },
  { timestamps: true }
);

// Délai de 3 jours avant reversement admin (voir Partie D.9-D.11)
paiementChariowSchema.index({ statut: 1, webhookReceivedAt: 1 });

export const PaiementChariow = model<IPaiementChariow>('PaiementChariow', paiementChariowSchema);
