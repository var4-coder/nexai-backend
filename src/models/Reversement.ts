import { Schema, model, Types } from 'mongoose';

/**
 * Méthode de retrait — mode "Compte NexAI" (Architecture v6, section 12).
 * Un document par ENCAISSEMENT reçu pour le compte d'un client (pas par
 * client) — permet un historique complet et un calcul de solde toujours
 * exact (encaissé - reversé), même avec des reversements partiels.
 */
export type ReversementSourceType = 'encaissement_visiteur' | 'reversement_admin';

export interface IReversement {
  _id: Types.ObjectId;
  userId: Types.ObjectId; // le client NexAI (propriétaire du site)
  siteId?: Types.ObjectId;
  type: ReversementSourceType;
  amountFcfa: number; // toujours positif ; le sens est donné par `type`
  /** Rempli uniquement pour type='reversement_admin' */
  reversedBy?: string; // email admin
  reversedAt?: Date;
  reference?: string; // référence manuelle saisie par l'admin (virement, etc.)
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reversementSchema = new Schema<IReversement>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    type: { type: String, enum: ['encaissement_visiteur', 'reversement_admin'], required: true },
    amountFcfa: { type: Number, required: true, min: 0 },
    reversedBy: { type: String },
    reversedAt: { type: Date },
    reference: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

export const Reversement = model<IReversement>('Reversement', reversementSchema);
