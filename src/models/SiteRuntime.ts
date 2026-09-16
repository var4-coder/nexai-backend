import { Schema, model, Types } from 'mongoose';
import { SiteNiche, PaymentMode, PaymentProvider } from '@/models/Site';

/**
 * Fiche runtime d'un site client, créée une seule fois au moment du
 * "Lancer mon site" (voir services/site-runtime.service.ts).
 *
 * Remplace l'ancienne table Supabase `sites_runtime`. Reste volontairement
 * une collection à part de la logique métier NexAI (users/jobs/credits...)
 * pour garder la même séparation logique qu'avant (Architecture §1 + §6),
 * même si tout vit maintenant dans le même cluster MongoDB.
 */
export interface ISiteRuntime {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  niche: SiteNiche;
  capacites: string[];
  paymentMode: PaymentMode;
  /** Lien de paiement réel injecté dans le site livré (validé avant déploiement) */
  paymentLink?: string;
  paymentProvider?: PaymentProvider;
  domainName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const siteRuntimeSchema = new Schema<ISiteRuntime>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, unique: true, index: true },
    niche: { type: String, required: true },
    capacites: { type: [String], default: [] },
    paymentMode: { type: String, enum: ['lien_personnel', 'chariow'], required: true },
    paymentLink: { type: String },
    paymentProvider: { type: String, enum: ['chariow', 'maketou', 'stripe', 'autre'] },
    domainName: { type: String },
  },
  { timestamps: true }
);

export const SiteRuntime = model<ISiteRuntime>('SiteRuntime', siteRuntimeSchema);
