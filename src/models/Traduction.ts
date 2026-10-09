import { Schema, model, models } from 'mongoose';

/**
 * Cache des traductions de contenus (titres et descriptions de l'Académie,
 * de la Boutique, des skills…) dans les langues d'interface. Un texte n'est
 * traduit qu'une seule fois par langue, puis servi à tous les clients.
 */
export interface ITraduction {
  /** Empreinte sha1 du texte source (français). */
  cle: string;
  langue: 'en';
  source: string;
  texte: string;
  createdAt: Date;
}

const traductionSchema = new Schema<ITraduction>(
  {
    cle: { type: String, required: true },
    langue: { type: String, enum: ['en'], required: true },
    source: { type: String, required: true, maxlength: 5000 },
    texte: { type: String, required: true, maxlength: 8000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
traductionSchema.index({ cle: 1, langue: 1 }, { unique: true });

export const Traduction = models.Traduction || model<ITraduction>('Traduction', traductionSchema);
