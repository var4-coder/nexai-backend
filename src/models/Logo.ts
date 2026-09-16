import { Schema, model, Types } from 'mongoose';

/**
 * Bibliothèque de logos persistée par compte (Partie D — point 6).
 *
 * Avant ce modèle, un logo généré n'existait que le temps de la réponse API
 * et, éventuellement, attaché à un Site précis (site.logoProposals). Il n'y
 * avait aucun moyen de proposer « logo déjà créé ici ? » dans le chat, faute
 * de mémoire au niveau du compte. Ce modèle comble ce manque : chaque logo
 * généré (ou uploadé par le client comme logo propre) est persisté ici,
 * indépendamment du site pour lequel il a été créé, et réutilisable pour
 * n'importe quel site futur du même compte.
 */

export type LogoSource = 'generated' | 'uploaded';

export interface ILogo {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Site pour lequel ce logo a été généré à l'origine — informatif seulement, le logo reste réutilisable ailleurs */
  siteId?: Types.ObjectId;
  brandName: string;
  niche?: string;
  url: string;
  prompt?: string;
  /** 'generated' = créé via Recraft ; 'uploaded' = fichier propre au client, envoyé depuis le chat */
  source: LogoSource;
  chosen: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const logoSchema = new Schema<ILogo>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site' },
    brandName: { type: String, required: true, trim: true },
    niche: { type: String },
    url: { type: String, required: true },
    prompt: { type: String },
    source: { type: String, enum: ['generated', 'uploaded'], default: 'generated' },
    chosen: { type: Boolean, default: false },
  },
  { timestamps: true }
);

logoSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const Logo = model<ILogo>('Logo', logoSchema);
