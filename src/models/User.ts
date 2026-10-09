import { Schema, model, Types } from 'mongoose';

export type UserRole = 'user' | 'admin' | 'finance' | 'support';
export type UserPlan = 'trial' | 'starter' | 'createur' | 'agence' | 'pro_max';

export interface IEmailVerification {
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
}

export interface IPasswordReset {
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
}

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  telephone?: string;
  telephonePays?: string;
  /**
   * Pays du compte (code ISO 2 lettres), choisi à l'inscription puis dans
   * Paramètres. Distinct de `telephonePays` (indicatif du numéro Mobile
   * Money) : changer l'un ne doit jamais réécrire l'autre.
   */
  pays?: string;
  prenom?: string;
  nom?: string;
  passwordHash?: string;
  googleId?: string;
  role: UserRole;
  plan: UserPlan;
  trialEndsAt?: Date;
  /**
   * Fin de la période d'abonnement payée.
   *
   * Un abonné dont cette date est passée garde l'ÉTIQUETTE de son plan (on
   * sait ainsi quelle offre lui reproposer), mais son abonnement est
   * INACTIF : plus de modification, plus de nouveau site, plus
   * d'encaissement, mention « Propulsé par NexAI » visible, hébergement
   * soumis au quota gratuit. Voir aUnAbonnementActif.
   */
  planExpiresAt?: Date;
  /**
   * Cadeau de bienvenue : une vidéo de 20 s offerte à la première
   * souscription d'un plan donnant accès à la vidéo (Créateur+ et au-delà).
   * `videoOfferteDisponible` est consommé à la génération ;
   * `cadeauBienvenueAttribue` garantit qu'il n'est jamais offert deux fois,
   * même après une résiliation et un réabonnement.
   */
  videoOfferteDisponible?: boolean;
  cadeauBienvenueAttribue?: boolean;
  /**
   * Présentateur choisi par le client pour ses vidéos avec avatar.
   *
   * Mémorisé sur le compte : le client retrouve le même présentateur d'une
   * vidéo à l'autre, ce qui construit une identité de marque reconnaissable.
   * Il peut en changer à tout moment. Sans effet sur les modes sans avatar.
   */
  avatarPrefere?: {
    genre?: string;
    carnation?: string;
    age?: string;
    style?: string;
  };
  creditsBalance: number;
  domainsUsed: number;
  /**
   * Part du budget domaine offert (DOMAIN_FREE_BUDGET_USD) déjà consommée, en
   * USD. Pro Max a 2 domaines inclus mais un budget PARTAGÉ : ce cumul évite
   * qu'un compte prenne deux domaines coûteux sur l'offre gratuite.
   */
  domainFreeBudgetUsedUsd: number;
  logosUsed: number;
  ipHash?: string;
  /**
   * Langue d'interface. Renseignée automatiquement d'après le pays choisi à
   * l'inscription, modifiable ensuite dans Paramètres.
   */
  langue?: 'fr' | 'en' | 'es' | 'pt' | 'ar';
  themePreference?: 'sombre' | 'clair';
  entrepriseNom?: string;
  deviceFingerprint?: string;
  referralCode?: string;
  referredByCode?: string;
  referredByUserId?: Types.ObjectId;
  referralRewardGranted?: boolean;
  videoTestUsed?: boolean;
  videoTestVideoAdId?: Types.ObjectId;
  defaultPaymentMode?: 'lien_personnel' | 'nexai';
  personalPaymentLink?: string;
  personalPaymentProvider?: 'chariow' | 'maketou' | 'stripe' | 'autre';
  compteReversement?: {
    type?: 'mobile_money' | 'crypto';
    operateur?: string;
    numero?: string;
    cryptoType?: 'usdt_bep20' | 'btc';
    cryptoAddress?: string;
  };
  emailVerifiedAt?: Date;
  emailVerification?: IEmailVerification;
  passwordReset?: IPasswordReset;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    telephone: { type: String },
    telephonePays: { type: String },
    pays: { type: String, uppercase: true, trim: true },
    prenom: { type: String },
    nom: { type: String },
    passwordHash: { type: String, select: false },
    googleId: { type: String, index: true, sparse: true, unique: true },
    role: { type: String, enum: ['user', 'admin', 'finance', 'support'], default: 'user' },
    plan: { type: String, enum: ['trial', 'starter', 'createur', 'agence', 'pro_max'], default: 'trial' },
    trialEndsAt: { type: Date },
    planExpiresAt: { type: Date, index: true },
    videoOfferteDisponible: { type: Boolean, default: false },
    cadeauBienvenueAttribue: { type: Boolean, default: false },
    avatarPrefere: {
      genre: { type: String },
      carnation: { type: String },
      age: { type: String },
      style: { type: String },
    },
    creditsBalance: { type: Number, default: 0, min: 0 },
    domainsUsed: { type: Number, default: 0, min: 0 },
    domainFreeBudgetUsedUsd: { type: Number, default: 0, min: 0 },
    logosUsed: { type: Number, default: 0, min: 0 },
    ipHash: { type: String },
    langue: { type: String, enum: ['fr', 'en', 'es', 'pt', 'ar'], default: 'fr' },
    themePreference: { type: String, enum: ['sombre', 'clair'], default: 'sombre' },
    entrepriseNom: { type: String },
    deviceFingerprint: { type: String, index: true },
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredByCode: { type: String },
    referredByUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    referralRewardGranted: { type: Boolean, default: false },
    videoTestUsed: { type: Boolean, default: false },
    videoTestVideoAdId: { type: Schema.Types.ObjectId, ref: 'VideoAd' },
    // Pas de valeur par défaut : c'est au client de choisir sa méthode de
    // retrait (Compte NexAI ou lien personnel) dans « Méthode de retrait ».
    defaultPaymentMode: {
      type: String,
      enum: ['lien_personnel', 'nexai'],
    },
    personalPaymentLink: { type: String },
    personalPaymentProvider: { type: String, enum: ['chariow', 'maketou', 'stripe', 'autre'] },
    compteReversement: {
      type: { type: String, enum: ['mobile_money', 'crypto'] },
      operateur: { type: String },
      numero: { type: String },
      cryptoType: { type: String, enum: ['usdt_bep20', 'btc'] },
      cryptoAddress: { type: String },
    },
    emailVerifiedAt: { type: Date },
    emailVerification: {
      codeHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
      attempts: { type: Number, default: 0, select: false },
      lastSentAt: { type: Date, select: false },
    },
    passwordReset: {
      codeHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
      attempts: { type: Number, default: 0, select: false },
      lastSentAt: { type: Date, select: false },
    },
  },
  { timestamps: true }
);

userSchema.index({ ipHash: 1 });

export const User = model<IUser>('User', userSchema);

/**
 * Méthode de retrait RÉELLEMENT choisie par le client, ou null s'il ne l'a
 * jamais définie. Les anciens comptes portent « nexai » par défaut en base
 * sans l'avoir choisi : on ne le compte que si la méthode est complète
 * (compte de reversement renseigné, ou lien personnel enregistré).
 */
export function methodeRetraitChoisie(u: {
  defaultPaymentMode?: string | null;
  compteReversement?: unknown;
  personalPaymentLink?: string | null;
}): 'nexai' | 'lien_personnel' | null {
  if (u.defaultPaymentMode === 'lien_personnel' && u.personalPaymentLink) return 'lien_personnel';
  if (u.defaultPaymentMode === 'nexai' && u.compteReversement) return 'nexai';
  return null;
}
