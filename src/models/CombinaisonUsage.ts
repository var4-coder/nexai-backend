import { Schema, model, Types } from 'mongoose';

/**
 * Combinaisons de design déjà utilisées, par métier et par cycle
 * (voir combinaison.service.ts). Une combinaison = famille + ouverture +
 * navigation + densité. Tant que toutes les combinaisons d'un métier n'ont
 * pas été utilisées dans le cycle en cours, aucune n'est réutilisée.
 */
export interface ICombinaisonUsage {
  _id: Types.ObjectId;
  niche: string; // identifiant Librairie (restaurant, hotellerie…)
  cycle: number;
  cle: string; // famille|hero|nav|densite
  famille: string;
  hero: string;
  nav: string;
  densite: string;
  siteId?: Types.ObjectId;
  createdAt: Date;
}

const schema = new Schema<ICombinaisonUsage>(
  {
    niche: { type: String, required: true },
    cycle: { type: Number, required: true },
    cle: { type: String, required: true },
    famille: { type: String, required: true },
    hero: String,
    nav: String,
    densite: String,
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
// Garantit qu'une combinaison n'est attribuée qu'UNE fois par cycle, même si
// deux générations du même métier démarrent à la même seconde.
schema.index({ niche: 1, cycle: 1, cle: 1 }, { unique: true });

export const CombinaisonUsage = model<ICombinaisonUsage>('CombinaisonUsage', schema);

/** Cycle en cours de chaque métier. */
export interface ICombinaisonCycle {
  _id: string; // identifiant Librairie du métier
  cycle: number;
}
const cycleSchema = new Schema<ICombinaisonCycle>({ _id: String, cycle: { type: Number, default: 1 } }, { versionKey: false });
export const CombinaisonCycle = model<ICombinaisonCycle>('CombinaisonCycle', cycleSchema);
