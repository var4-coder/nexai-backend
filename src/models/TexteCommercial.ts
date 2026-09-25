import { Schema, model, Types } from 'mongoose';

/**
 * Textes commerciaux affichés au client, stockés en base plutôt qu'écrits en
 * dur dans le frontend.
 *
 * Objectif : quand un tarif change, tous les textes qui le mentionnent
 * peuvent être mis à jour SANS redéploiement. Sinon la page d'accueil, le
 * guide et l'aide continuent d'annoncer d'anciens prix, et le client
 * découvre l'écart au moment de payer.
 *
 * La mise à jour est PROPOSÉE par Sonnet 5, jamais publiée directement :
 * l'administrateur voit l'avant/après, peut corriger, puis valide. Un modèle
 * qui réécrirait seul une vitrine commerciale pourrait déformer une
 * promesse sans que personne ne s'en aperçoive.
 *
 * Les CGV et mentions légales sont VOLONTAIREMENT exclues : ce sont des
 * documents contractuels, qui ne changent que sous le contrôle direct de
 * l'administrateur.
 */

/** Emplacement du texte dans l'interface. */
export type TexteEmplacement =
  | 'accueil'
  | 'guide'
  | 'aide'
  | 'hub_creation'
  | 'video'
  | 'abonnement'
  | 'credits'
  | 'assistant';

export interface ITexteCommercial {
  _id: Types.ObjectId;
  /** Identifiant stable, lu par le frontend. */
  cle: string;
  emplacement: TexteEmplacement;
  /** Ce qui est affiché aujourd'hui. */
  contenu: string;
  /** Proposition de Sonnet, en attente de validation. Null si aucune. */
  propositionContenu?: string | null;
  /** Ce qui a motivé la proposition (« tarif 20 s passé à 23 crédits »). */
  propositionMotif?: string | null;
  propositionLe?: Date | null;
  /** Description de l'usage du texte, pour guider la reformulation. */
  role?: string;
  majLe: Date;
  majPar?: 'admin' | 'sonnet';
  createdAt: Date;
  updatedAt: Date;
}

const texteCommercialSchema = new Schema<ITexteCommercial>(
  {
    cle: { type: String, required: true, unique: true, index: true },
    emplacement: {
      type: String,
      enum: ['accueil', 'guide', 'aide', 'hub_creation', 'video', 'abonnement', 'credits', 'assistant'],
      required: true,
      index: true,
    },
    contenu: { type: String, required: true },
    propositionContenu: { type: String, default: null },
    propositionMotif: { type: String, default: null },
    propositionLe: { type: Date, default: null },
    role: { type: String },
    majLe: { type: Date, default: Date.now },
    majPar: { type: String, enum: ['admin', 'sonnet'] },
  },
  { timestamps: true }
);

export const TexteCommercial = model<ITexteCommercial>('TexteCommercial', texteCommercialSchema);
