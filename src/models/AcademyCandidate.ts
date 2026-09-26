import { Schema, model, Types } from 'mongoose';

/**
 * Vidéo sous licence libre repérée par le catalogue automatique de l'Académie.
 *
 * Cycle de vie :
 *   trouvee ─(Évaluer)→ evaluee ─(Approuver)→ importee
 *                                    │
 *                                    ├─ YouTube : « apercu » (intégration ouverte, jamais
 *                                    │  payante) et/ou « fichier_a_obtenir » (le fichier
 *                                    │  original est demandé à l'auteur, puis déposé ici)
 *                                    └─ PeerTube : import direct sur Bunny (téléchargement
 *                                       proposé par la plateforme elle-même)
 *   à tout moment → rejetee
 *
 * Rien n'est jamais publié automatiquement : un contenu importé arrive en
 * brouillon dans l'Académie, l'admin le relit puis le publie.
 */

export type CandidateSource = 'youtube' | 'peertube';
export type CandidateStatus =
  | 'trouvee'
  | 'evaluee'
  | 'rejetee'
  | 'fichier_a_obtenir'
  | 'importee';

export interface ICandidateEvaluation {
  /** Moteur utilisé pour la notation */
  moteur: 'gemini' | 'claude';
  /** Notes sur 10 */
  pedagogie: number;
  qualiteTechnique: number;
  pertinenceModule: number;
  actualite: number;
  /** Note globale sur 10 */
  global: number;
  /** La vidéo est-elle en français ? */
  enFrancais: boolean;
  /** Promotion / sponsor / vente insistante détectée dans la vidéo elle-même */
  promotionDetectee: boolean;
  /** Suspicion de ré-upload d'une œuvre dont le compte n'est pas l'auteur */
  suspicionReupload: boolean;
  verdict: 'recommandee' | 'acceptable' | 'a_eviter';
  resume: string;
  pointsForts: string[];
  pointsFaibles: string[];
  /** Titre de formation suggéré (parmi le plan éditorial du module) */
  formationSuggeree?: string;
  evalueeLe: Date;
}

export interface IAcademyCandidate {
  _id: Types.ObjectId;
  source: CandidateSource;
  /** ID YouTube ou UUID PeerTube */
  externalId: string;
  /** Pour PeerTube : hôte de l'instance d'origine */
  hote?: string;
  url: string;
  titre: string;
  description?: string;
  auteur: string;
  auteurUrl?: string;
  duree?: number;
  langue?: string;
  licence: 'cc-by' | 'cc-by-sa' | 'cc-by-nd' | 'cc0' | 'domaine-public';
  miniatureUrl?: string;
  /** Module de l'Académie pour lequel la vidéo a été cherchée */
  module: string;
  requete: string;
  /** PeerTube : l'instance autorise-t-elle le téléchargement ? */
  telechargementAutorise?: boolean;
  status: CandidateStatus;
  evaluation?: ICandidateEvaluation;
  /** Contenus Académie créés à partir de ce candidat */
  apercuContentId?: Types.ObjectId;
  seanceContentId?: Types.ObjectId;
  derniereErreur?: string;
  createdAt: Date;
  updatedAt: Date;
}

const candidateSchema = new Schema<IAcademyCandidate>(
  {
    source: { type: String, enum: ['youtube', 'peertube'], required: true },
    externalId: { type: String, required: true },
    hote: { type: String },
    url: { type: String, required: true },
    titre: { type: String, required: true },
    description: { type: String },
    auteur: { type: String, required: true },
    auteurUrl: { type: String },
    duree: { type: Number },
    langue: { type: String },
    licence: {
      type: String,
      enum: ['cc-by', 'cc-by-sa', 'cc-by-nd', 'cc0', 'domaine-public'],
      required: true,
    },
    miniatureUrl: { type: String },
    module: { type: String, required: true, index: true },
    requete: { type: String, required: true },
    telechargementAutorise: { type: Boolean },
    status: {
      type: String,
      enum: ['trouvee', 'evaluee', 'rejetee', 'fichier_a_obtenir', 'importee'],
      default: 'trouvee',
      index: true,
    },
    evaluation: {
      moteur: { type: String, enum: ['gemini', 'claude'] },
      pedagogie: Number,
      qualiteTechnique: Number,
      pertinenceModule: Number,
      actualite: Number,
      global: Number,
      enFrancais: Boolean,
      promotionDetectee: Boolean,
      suspicionReupload: Boolean,
      verdict: { type: String, enum: ['recommandee', 'acceptable', 'a_eviter'] },
      resume: String,
      pointsForts: [String],
      pointsFaibles: [String],
      formationSuggeree: String,
      evalueeLe: Date,
    },
    apercuContentId: { type: Schema.Types.ObjectId, ref: 'AcademyContent' },
    seanceContentId: { type: Schema.Types.ObjectId, ref: 'AcademyContent' },
    derniereErreur: { type: String },
  },
  { timestamps: true }
);

// Une même vidéo n'est enregistrée qu'une fois, même trouvée par plusieurs recherches.
candidateSchema.index({ source: 1, externalId: 1 }, { unique: true });

candidateSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const AcademyCandidate = model<IAcademyCandidate>('AcademyCandidate', candidateSchema);
