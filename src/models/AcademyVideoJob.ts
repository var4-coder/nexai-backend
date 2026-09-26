import { Schema, model, Types } from 'mongoose';

/**
 * Fabrication d'une vidéo IA de l'Académie à partir d'un PDF (ou d'un résumé).
 *
 * Étapes :
 *   script_en_cours → script_pret  (Claude a lu le PDF et écrit l'explication ;
 *                                   l'admin relit / modifie le script)
 *   → fabrication   (diapositives + voix off + montage + envoi Bunny)
 *   → terminee      (une leçon est créée en BROUILLON dans la formation)
 *   ou erreur à n'importe quelle étape (relançable).
 */

export type VideoJobStatut = 'script_en_cours' | 'script_pret' | 'fabrication' | 'terminee' | 'erreur';
export type VideoJobPartie = 'bases' | 'complet' | 'pratique';
export type VideoJobVoix = 'gemini' | 'elevenlabs';

export interface IScene {
  titre: string;
  /** 2 à 5 points clés affichés sur la diapositive */
  points: string[];
  /** Texte dit par la voix off — une EXPLICATION, jamais une lecture du PDF */
  narration: string;
}

export interface IScript {
  titre: string;
  description: string;
  scenes: IScene[];
}

export interface IAcademyVideoJob {
  _id: Types.ObjectId;
  packId: Types.ObjectId;
  module: string;
  partie: VideoJobPartie;
  voix: VideoJobVoix;
  sourceNom: string;
  /** Texte extrait du PDF (borné) — la seule base autorisée pour le script */
  sourceTexte: string;
  statut: VideoJobStatut;
  script?: IScript;
  /** 0 à 100, pendant la fabrication */
  progression: number;
  etape?: string;
  contentId?: Types.ObjectId;
  dureeSecondes?: number;
  /** Estimation du coût (IA + voix), en dollars */
  coutUsd: number;
  erreur?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sceneSchema = new Schema<IScene>(
  {
    titre: { type: String, required: true },
    points: [{ type: String }],
    narration: { type: String, required: true },
  },
  { _id: false }
);

const schema = new Schema<IAcademyVideoJob>(
  {
    packId: { type: Schema.Types.ObjectId, ref: 'AcademyPack', required: true, index: true },
    module: { type: String, required: true },
    partie: { type: String, enum: ['bases', 'complet', 'pratique'], required: true },
    voix: { type: String, enum: ['gemini', 'elevenlabs'], default: 'gemini' },
    sourceNom: { type: String, required: true },
    sourceTexte: { type: String, required: true, select: false },
    statut: {
      type: String,
      enum: ['script_en_cours', 'script_pret', 'fabrication', 'terminee', 'erreur'],
      default: 'script_en_cours',
      index: true,
    },
    script: {
      titre: String,
      description: String,
      scenes: [sceneSchema],
    },
    progression: { type: Number, default: 0 },
    etape: { type: String },
    contentId: { type: Schema.Types.ObjectId, ref: 'AcademyContent' },
    dureeSecondes: { type: Number },
    coutUsd: { type: Number, default: 0 },
    erreur: { type: String },
  },
  { timestamps: true }
);

schema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const AcademyVideoJob = model<IAcademyVideoJob>('AcademyVideoJob', schema);
