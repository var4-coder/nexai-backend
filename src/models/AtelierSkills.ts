import { Schema, model, Types } from 'mongoose';

/**
 * ATELIER SKILLS NexAI — option 1 (atelier PRIVÉ de l'admin).
 * Cahier des charges v1 (02/10/2026), consignes v1.2, avenant v1.3 (03/10/2026).
 *
 * Collections : skill_requests, skill_runs, skill_test_cases, skills,
 * skill_grids, skill_settings. Aucune intégration boutique / Chariow /
 * paiement : l'admin télécharge les fichiers et les dépose lui-même.
 */

// ─── Demande ──────────────────────────────────────────────────────────────

export interface ISkillRequest {
  _id: Types.ObjectId;
  domaine: string;
  tache: string;
  public: string;
  langue: string;
  contexte: { pays?: string; devise?: string; canal?: string; autre?: string };
  produitPhare: boolean;
  /** Skills déjà validés du même domaine (nom + description), pour le test de déclenchement. */
  voisins: { nom: string; description: string }[];
  /** 'skill' = skill à vendre ; 'grille' = révision de la grille de jugement. */
  type: 'skill' | 'grille';
  creePar?: string;
  /** Commande d'un client (Skill NexAI) : propriétaire, crédits débités, budget propre. */
  userId?: Types.ObjectId;
  chatSessionId?: Types.ObjectId;
  creditsDebites?: number;
  rembourse?: boolean;
  /** Le client a utilisé son second essai gratuit (un seul par commande). */
  relanceClient?: boolean;
  /** Plafond de coût (USD) propre à cette commande ; remplace celui des réglages. */
  plafondUSD?: number;
  createdAt: Date;
}

const requestSchema = new Schema<ISkillRequest>(
  {
    domaine: { type: String, required: true, trim: true, maxlength: 120 },
    tache: { type: String, required: true, trim: true, maxlength: 2000 },
    public: { type: String, default: '', maxlength: 500 },
    langue: { type: String, default: 'fr', maxlength: 40 },
    contexte: {
      pays: String,
      devise: String,
      canal: String,
      autre: String,
    },
    produitPhare: { type: Boolean, default: false },
    voisins: [{ _id: false, nom: String, description: String }],
    type: { type: String, enum: ['skill', 'grille'], default: 'skill' },
    creePar: String,
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    chatSessionId: { type: Schema.Types.ObjectId, ref: 'ChatSession' },
    creditsDebites: Number,
    rembourse: Boolean,
    relanceClient: Boolean,
    plafondUSD: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'skill_requests' }
);
export const SkillRequest = model<ISkillRequest>('SkillRequest', requestSchema);

// ─── Exécution ────────────────────────────────────────────────────────────

export const ETAPES_SKILL = [
  'skill_cadrage',
  'skill_dossier',
  'skill_propositions',
  'skill_tests',
  'skill_fusion',
  'skill_controle',
  'skill_livrables',
] as const;
export type EtapeSkill = (typeof ETAPES_SKILL)[number];

/** Les 5 étapes affichées (avenant v1.3) et les tâches worker qui les composent. */
export const ETAPES_AFFICHEES: { numero: number; titre: string; taches: EtapeSkill[] }[] = [
  { numero: 1, titre: 'Cadrage et dossier de faits', taches: ['skill_cadrage', 'skill_dossier'] },
  { numero: 2, titre: 'Rédaction à l’aveugle', taches: ['skill_propositions'] },
  { numero: 3, titre: 'Test des 3 versions', taches: ['skill_tests'] },
  { numero: 4, titre: 'Auto-critique puis fusion', taches: ['skill_fusion'] },
  { numero: 5, titre: 'Contrôle final et livrables', taches: ['skill_controle', 'skill_livrables'] },
];

export type StatutEtape = 'en_attente' | 'en_cours' | 'termine' | 'echec' | 'saute';
export type StatutRun = 'en_attente' | 'en_cours' | 'termine' | 'echec' | 'plafond_atteint';
export type VerdictSkill = 'publie' | 'a_retravailler' | 'ecarte';

export interface IAppelModele {
  poste: string;
  modele: string;
  entree: number;
  sortie: number;
  cache: number;
  coutUSD: number;
  dureeMs: number;
  tentatives: number;
  erreur?: string;
}

export interface IEtapeRun {
  nom: EtapeSkill;
  statut: StatutEtape;
  /** Sortie JSON de l'étape (reprise sans tout relancer). */
  sortie?: unknown;
  appels: IAppelModele[];
  jetons: number;
  coutUSD: number;
  debut?: Date;
  fin?: Date;
  erreur?: string;
}

export interface ISkillRun {
  _id: Types.ObjectId;
  requestId: Types.ObjectId;
  statut: StatutRun;
  etapeCourante?: EtapeSkill;
  etapes: IEtapeRun[];
  coutTotalUSD: number;
  grilleVersion?: number;
  /** Configuration utilisée (postes, seuils, prix) : comparaison entre exécutions. */
  configuration?: unknown;
  /** Ordre des versions V1, V2, V3 → rédacteur (jamais montré aux IA). */
  correspondanceVersions?: Record<string, string>;
  versionBase?: string;
  versionFinale?: { skillMd: string; references: { nom: string; contenu: string }[]; faitsUtilises: unknown[] };
  noteClassement?: number;
  noteFinale?: number;
  scoreEntrainementGagnant?: number;
  scoreControle?: number;
  declenchement?: { correctes: number; total: number };
  vetos?: { id: string; present: boolean; justification?: string; source: 'juge' | 'code' }[];
  alertes?: string[];
  verdict?: VerdictSkill;
  /** 0 ou 1 : une seule relance après « à retravailler ». */
  relances: number;
  /** Reprises automatiques après interruption du worker (0 ou 1, voir recupererSkillsBloques). */
  reprisesAuto?: number;
  skillId?: Types.ObjectId;
  /** Sorties intermédiaires purgées (bouton admin « Purger les brouillons »). */
  purge?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const appelSchema = new Schema<IAppelModele>(
  {
    poste: String,
    modele: String,
    entree: Number,
    sortie: Number,
    cache: Number,
    coutUSD: Number,
    dureeMs: Number,
    tentatives: Number,
    erreur: String,
  },
  { _id: false }
);

const etapeSchema = new Schema<IEtapeRun>(
  {
    nom: { type: String, enum: ETAPES_SKILL, required: true },
    statut: { type: String, enum: ['en_attente', 'en_cours', 'termine', 'echec', 'saute'], default: 'en_attente' },
    sortie: Schema.Types.Mixed,
    appels: [appelSchema],
    jetons: { type: Number, default: 0 },
    coutUSD: { type: Number, default: 0 },
    debut: Date,
    fin: Date,
    erreur: String,
  },
  { _id: false }
);

const runSchema = new Schema<ISkillRun>(
  {
    requestId: { type: Schema.Types.ObjectId, ref: 'SkillRequest', required: true, index: true },
    statut: {
      type: String,
      enum: ['en_attente', 'en_cours', 'termine', 'echec', 'plafond_atteint'],
      default: 'en_attente',
      index: true,
    },
    etapeCourante: { type: String, enum: ETAPES_SKILL },
    etapes: [etapeSchema],
    coutTotalUSD: { type: Number, default: 0 },
    grilleVersion: Number,
    configuration: Schema.Types.Mixed,
    correspondanceVersions: Schema.Types.Mixed,
    versionBase: String,
    versionFinale: Schema.Types.Mixed,
    noteClassement: Number,
    noteFinale: Number,
    scoreEntrainementGagnant: Number,
    scoreControle: Number,
    declenchement: { correctes: Number, total: Number },
    vetos: [{ _id: false, id: String, present: Boolean, justification: String, source: String }],
    alertes: [String],
    verdict: { type: String, enum: ['publie', 'a_retravailler', 'ecarte'] },
    relances: { type: Number, default: 0 },
    reprisesAuto: { type: Number, default: 0 },
    skillId: { type: Schema.Types.ObjectId, ref: 'Skill' },
    purge: Boolean,
  },
  { timestamps: true, collection: 'skill_runs' }
);
export const SkillRun = model<ISkillRun>('SkillRun', runSchema);

// ─── Cas de test ──────────────────────────────────────────────────────────

export type TypeJeuCas = 'entrainement' | 'controle' | 'reserve' | 'declenchement' | 'distracteur';

export interface ISkillTestCase {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  type: TypeJeuCas;
  /** Identifiant du cas dans le cadrage (E1, C1, D1…). */
  casId: string;
  contenu: unknown;
  criteres: unknown[];
  visibleRedacteurs: boolean;
}

const caseSchema = new Schema<ISkillTestCase>(
  {
    runId: { type: Schema.Types.ObjectId, ref: 'SkillRun', required: true, index: true },
    type: { type: String, enum: ['entrainement', 'controle', 'reserve', 'declenchement', 'distracteur'], required: true },
    casId: String,
    contenu: Schema.Types.Mixed,
    criteres: [Schema.Types.Mixed],
    visibleRedacteurs: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'skill_test_cases' }
);
export const SkillTestCase = model<ISkillTestCase>('SkillTestCase', caseSchema);

// ─── Skill validé ─────────────────────────────────────────────────────────

export interface ISkillFichiers {
  skillMd: string;
  references: { nom: string; contenu: string }[];
  aColler: string;
  guidePdf?: Buffer;
  preuvePdf?: Buffer;
  ficheProduit: string;
  zip?: Buffer;
}

export interface ISkill {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  slug: string;
  nom: string;
  description: string;
  domaine: string;
  version: number;
  fichiers: ISkillFichiers;
  note?: number;
  verdict: VerdictSkill;
  grilleVersion?: number;
  deposeEnBoutique: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const skillSchema = new Schema<ISkill>(
  {
    runId: { type: Schema.Types.ObjectId, ref: 'SkillRun', required: true },
    slug: { type: String, required: true, index: true },
    nom: { type: String, required: true },
    description: { type: String, default: '' },
    domaine: String,
    version: { type: Number, default: 1 },
    fichiers: {
      skillMd: String,
      references: [{ _id: false, nom: String, contenu: String }],
      aColler: String,
      guidePdf: Buffer,
      preuvePdf: Buffer,
      ficheProduit: String,
      zip: Buffer,
    },
    note: Number,
    verdict: { type: String, enum: ['publie', 'a_retravailler', 'ecarte'], default: 'publie' },
    grilleVersion: Number,
    deposeEnBoutique: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: 'skills' }
);
export const Skill = model<ISkill>('Skill', skillSchema);

// ─── Grille de jugement (versionnée, une seule active) ────────────────────

export interface ISkillGrid {
  _id: Types.ObjectId;
  version: number;
  contenu: string;
  active: boolean;
  runId?: Types.ObjectId;
  createdAt: Date;
}

const gridSchema = new Schema<ISkillGrid>(
  {
    version: { type: Number, required: true, unique: true },
    contenu: { type: String, required: true },
    active: { type: Boolean, default: false, index: true },
    runId: { type: Schema.Types.ObjectId, ref: 'SkillRun' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'skill_grids' }
);
export const SkillGrid = model<ISkillGrid>('SkillGrid', gridSchema);

// ─── Réglages (document unique, versionné) ────────────────────────────────

export interface IPosteReglage {
  modele: string;
  effort: 'low' | 'medium' | 'high' | 'defaut';
}

export interface IPrixModele {
  entree: number;
  sortie: number;
  cache: number;
}

export interface ISkillSettings {
  _id: string;
  version: number;
  postes: Record<string, IPosteReglage>;
  seuils: {
    note: number;
    controlePct: number;
    declenchementMin: number;
    egalite: number;
    ecartAvanceLeger: number;
    affinite: number;
    casEchoue: number;
  };
  plafondUSD: number;
  nbCasEntrainement: number;
  nbCasControle: number;
  passages: number;
  modeRenforce: boolean;
  prix: Record<string, IPrixModele>;
  /** Consignes P0…P12 et blocs partagés, modifiables (versionnés avec le document). */
  consignes: Record<string, string>;
  updatedAt?: Date;
  updatedBy?: string;
}

const settingsSchema = new Schema<ISkillSettings>(
  {
    _id: { type: String, default: 'atelier' },
    version: { type: Number, default: 1 },
    postes: Schema.Types.Mixed,
    seuils: Schema.Types.Mixed,
    plafondUSD: Number,
    nbCasEntrainement: Number,
    nbCasControle: Number,
    passages: Number,
    modeRenforce: Boolean,
    prix: Schema.Types.Mixed,
    consignes: Schema.Types.Mixed,
    updatedBy: String,
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'skill_settings', minimize: false }
);
export const SkillSettings = model<ISkillSettings>('SkillSettings', settingsSchema);

/** Historique des réglages (une entrée par modification, pour comparer / revenir). */
const settingsHistSchema = new Schema(
  { version: Number, contenu: Schema.Types.Mixed, par: String },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'skill_settings_historique' }
);
export const SkillSettingsHistorique = model('SkillSettingsHistorique', settingsHistSchema);
