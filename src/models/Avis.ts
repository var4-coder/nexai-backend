import { Schema, model, Types } from 'mongoose';

/**
 * Témoignages / avis pour la landing page.
 * GET public /avis (active: true uniquement).
 * CRUD admin /admin/avis.
 */
/**
 * Origine de l'avis — distinction CRITIQUE.
 *
 * Le seuil négatif NexAI (quality-report.service.ts) ne doit compter QUE
 * les avis 'client'. Sans cette séparation, générer des avis élogieux
 * embellirait artificiellement l'indicateur qualité et empêcherait Fable
 * de se déclencher alors que les vrais clients sont mécontents.
 */
export type AvisSource = 'client' | 'genere_admin';

export interface IAvis {
  _id: Types.ObjectId;
  source: AvisSource;
  /** Auteur réel, uniquement pour les avis clients */
  userId?: Types.ObjectId;
  name: string;
  role: string;
  content: string;
  rating: number;
  active: boolean;
  order?: number;
  createdAt: Date;
  updatedAt: Date;
}

const avisSchema = new Schema<IAvis>(
  {
    source: {
      type: String,
      enum: ['client', 'genere_admin'],
      required: true,
      default: 'client',
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5, default: 5 },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

avisSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const Avis = model<IAvis>('Avis', avisSchema);
