import { Schema, model, Types } from 'mongoose';

/**
 * Client d'une agence — Espace Agence (plans `agence` / `pro_max`).
 * Un Client appartient à un seul utilisateur agence (agencyUserId) et peut
 * avoir plusieurs Sites (voir Site.clientId).
 */
export interface IClient {
  _id: Types.ObjectId;
  agencyUserId: Types.ObjectId; // référence au User (plan agence/pro_max) propriétaire
  nom: string;
  contactEmail?: string;
  contactTelephone?: string;
  notes?: string;
  dernierAcces?: Date; // mis à jour à chaque action liée à ce client (ex: quick-edit)
  createdAt: Date;
  updatedAt: Date;
}

const clientSchema = new Schema<IClient>(
  {
    agencyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    nom: { type: String, required: true, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    contactTelephone: { type: String, trim: true },
    notes: { type: String },
    dernierAcces: { type: Date },
  },
  { timestamps: true }
);

export const Client = model<IClient>('Client', clientSchema);
