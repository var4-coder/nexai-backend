import { Schema, model, Types } from 'mongoose';

/**
 * Une soumission envoyée par un visiteur du site LIVRÉ à un client NexAI
 * (formulaire de contact, réservation, commande...). C'est le backend
 * fonctionnel qui manquait aux sites générés : sans ça, ces formulaires
 * n'envoyaient les données nulle part (voir routes/public.routes.ts).
 *
 * Une collection unique pour tous les sites clients (isolée par siteId) —
 * MongoDB gère ça sans souci à grande échelle, avec un index sur siteId.
 */
export type SiteSubmissionType = 'contact' | 'reservation' | 'commande' | 'avis' | 'autre';
export type SiteSubmissionStatus = 'nouveau' | 'lu' | 'traite' | 'spam';

export interface ISiteSubmission {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  type: SiteSubmissionType;
  data: Record<string, unknown>;
  status: SiteSubmissionStatus;
  ipHash?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const siteSubmissionSchema = new Schema<ISiteSubmission>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    type: {
      type: String,
      enum: ['contact', 'reservation', 'commande', 'avis', 'autre'],
      default: 'contact',
    },
    data: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['nouveau', 'lu', 'traite', 'spam'], default: 'nouveau' },
    ipHash: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

siteSubmissionSchema.index({ siteId: 1, createdAt: -1 });

siteSubmissionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const SiteSubmission = model<ISiteSubmission>('SiteSubmission', siteSubmissionSchema);
