import { Schema, model, Types } from 'mongoose';

/**
 * Textes et visuel d'un DOMAINE de l'Académie (les 22 domaines de
 * data/academy-modules.ts). Le titre, l'emoji et l'ordre restent dans le code ;
 * ici on garde ce que l'admin peut modifier : accroche, description, image.
 * Créé au premier démarrage avec les textes de base, jamais écrasé ensuite.
 */
export interface IAcademyDomaine {
  _id: Types.ObjectId;
  slug: string;
  accroche: string;
  description: string;
  imageUrl?: string;
  imagePhotographe?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAcademyDomaine>(
  {
    slug: { type: String, required: true, unique: true },
    accroche: { type: String, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String },
    imagePhotographe: { type: String },
  },
  { timestamps: true }
);

export const AcademyDomaine = model<IAcademyDomaine>('AcademyDomaine', schema);
