import { Schema, model } from 'mongoose';

/**
 * Historique des modifications de la Librairie design faites depuis l'admin.
 *
 * Chaque enregistrement garde le document TEL QU'IL ÉTAIT avant la
 * modification : revenir en arrière consiste à remettre ce contenu (et crée
 * lui-même une nouvelle entrée — un retour arrière est une nouvelle version,
 * jamais un effacement de l'historique).
 */
export type ActionLibrairie = 'modification' | 'retour_arriere' | 'version_livree';

export interface ILibrairieHistorique {
  collectionLib: string;
  docId: string;
  /** Numéro de version du document APRÈS cette action (1, 2, 3…). */
  version: number;
  action: ActionLibrairie;
  /** Contenu complet du document AVANT l'action. */
  avant: Record<string, unknown> | null;
  /** Contenu complet du document APRÈS l'action. */
  apres: Record<string, unknown>;
  auteur: string;
  commentaire?: string;
  createdAt?: Date;
}

const schema = new Schema<ILibrairieHistorique>(
  {
    collectionLib: { type: String, required: true, index: true },
    docId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    action: { type: String, enum: ['modification', 'retour_arriere', 'version_livree'], required: true },
    avant: { type: Schema.Types.Mixed, default: null },
    apres: { type: Schema.Types.Mixed, required: true },
    auteur: { type: String, required: true },
    commentaire: { type: String, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'library_history' }
);

schema.index({ collectionLib: 1, docId: 1, version: -1 });

export const LibrairieHistorique = model<ILibrairieHistorique>('LibrairieHistorique', schema);
