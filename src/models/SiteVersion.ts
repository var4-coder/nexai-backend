import { Schema, model, Types } from 'mongoose';

/**
 * Historique des versions d'un site — Architecture v6, section 10.
 *
 * Les 10 dernières versions de chaque site sont conservées, avec un bouton
 * « Restaurer cette version ». C'est la réponse à la principale source de
 * litige : une modification IA qui casse le site sans recours possible.
 *
 * Une version est enregistrée automatiquement à chaque : mise en ligne,
 * modification IA, ou édition manuelle.
 */
export type TypeChangement = 'mise_en_ligne' | 'modification_ia' | 'edition_manuelle' | 'restauration';

export interface ISiteVersion {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Numéro croissant par site, affiché au client (« Version 7 »). */
  numero: number;
  typeChangement: TypeChangement;
  /** Instantané complet du HTML au moment de l'enregistrement. */
  htmlSnapshot: string;
  /** Pages secondaires, pour les sites multi-pages. */
  pagesSnapshot?: { slug: string; title?: string; html: string }[];
  /** Résumé lisible : « Textes de la page d'accueil modifiés » */
  resume?: string;
  createdAt: Date;
}

const siteVersionSchema = new Schema<ISiteVersion>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    numero: { type: Number, required: true },
    typeChangement: {
      type: String,
      enum: ['mise_en_ligne', 'modification_ia', 'edition_manuelle', 'restauration'],
      required: true,
    },
    htmlSnapshot: { type: String, required: true },
    pagesSnapshot: [
      {
        slug: String,
        title: String,
        html: String,
        _id: false,
      },
    ],
    resume: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Historique d'un site, du plus récent au plus ancien.
siteVersionSchema.index({ siteId: 1, createdAt: -1 });

export const SiteVersion = model<ISiteVersion>('SiteVersion', siteVersionSchema);
