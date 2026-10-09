import { Schema, model } from 'mongoose';

/**
 * Compteurs journaliers pour le Bilan de l'admin (un document par jour et
 * par clé). Aucune donnée personnelle : seulement des totaux.
 *
 *  - type « ia »      : coût IA réel d'un modèle ce jour-là (clé = modèle)
 *  - type « visite »  : visites du site NexAI (clé = source : facebook, tiktok, direct…)
 *  - type « visiteur »: visiteurs uniques du site NexAI (clé = source)
 */
export interface IStatsJour {
  jour: string; // AAAA-MM-JJ (UTC)
  type: 'ia' | 'visite' | 'visiteur';
  cle: string;
  nombre: number;
  coutUsd: number;
  entree: number;
  sortie: number;
}

const statsJourSchema = new Schema<IStatsJour>(
  {
    jour: { type: String, required: true },
    type: { type: String, required: true },
    cle: { type: String, required: true },
    nombre: { type: Number, default: 0 },
    coutUsd: { type: Number, default: 0 },
    entree: { type: Number, default: 0 },
    sortie: { type: Number, default: 0 },
  },
  { timestamps: false }
);
statsJourSchema.index({ jour: 1, type: 1, cle: 1 }, { unique: true });

export const StatsJour = model<IStatsJour>('StatsJour', statsJourSchema);

/** Empreintes de visiteurs du jour (pour compter les visiteurs uniques), effacées après 2 jours. */
const empreinteSchema = new Schema({ e: { type: String, required: true, unique: true }, creeLe: { type: Date, default: Date.now, expires: 172800 } });
export const EmpreinteVisiteNexai = model('EmpreinteVisiteNexai', empreinteSchema);

/** Dépense publicitaire saisie par l'admin (ou importée plus tard depuis Meta / TikTok). */
export interface IDepensePub {
  jour: string;
  plateforme: string; // facebook, instagram, tiktok, google, autre
  montantFcfa: number;
  note?: string;
  /** Ligne importée automatiquement ('meta' ou 'tiktok') ; absente = saisie à la main. */
  auto?: string;
}
const depensePubSchema = new Schema<IDepensePub>(
  {
    jour: { type: String, required: true, index: true },
    plateforme: { type: String, required: true },
    montantFcfa: { type: Number, required: true, min: 0 },
    note: { type: String },
    auto: { type: String, index: true },
  },
  { timestamps: true }
);
export const DepensePub = model<IDepensePub>('DepensePub', depensePubSchema);
