import { Schema, model, Types } from 'mongoose';

/**
 * Témoignages / avis pour la landing page.
 * GET public /avis (active: true uniquement).
 * CRUD admin /admin/avis.
 */
export interface IAvis {
  _id: Types.ObjectId;
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
