import { Schema, model, Types } from 'mongoose';

export type AcademyContentType = 'video' | 'pdf';
export type AcademyAccess = 'gratuit' | 'payant';

export type AcademyHosting = 'cloudinary' | 'embed_externe';

export interface IAcademyContent {
  _id: Types.ObjectId;
  title: string;
  type: AcademyContentType;
  access: AcademyAccess;
  creditsCost?: number; // requis si access = 'payant'
  // hosting = 'cloudinary' : sourceUrl est un public_id Cloudinary (ressource "authenticated"),
  //   servi via /academy/:id/stream ou /video-stream avec token signé courte durée — jamais d'URL directe.
  // hosting = 'embed_externe' : sourceUrl est une URL YouTube/Dailymotion non répertoriée (vidéo uniquement).
  //   Protection dissuasive seulement : l'ID est visible dans le DOM une fois le lecteur chargé.
  hosting: AcademyHosting;
  // PDF : viewer intégré, jamais de téléchargement direct, URL jamais exposée directement
  sourceUrl: string;
  category?: string;
  /** Groupement par formation (frontend regroupe PDF / Vidéos par formation) */
  formationId?: string;
  formationTitle?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const academyContentSchema = new Schema<IAcademyContent>(
  {
    title: { type: String, required: true },
    type: { type: String, enum: ['video', 'pdf'], required: true },
    access: { type: String, enum: ['gratuit', 'payant'], required: true },
    creditsCost: { type: Number, min: 0 },
    hosting: { type: String, enum: ['cloudinary', 'embed_externe'], required: true, default: 'cloudinary' },
    sourceUrl: { type: String, required: true, select: false }, // jamais exposée directement au client
    category: { type: String },
    formationId: { type: String, index: true },
    formationTitle: { type: String },
    description: { type: String },
  },
  { timestamps: true }
);

academyContentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const AcademyContent = model<IAcademyContent>('AcademyContent', academyContentSchema);
