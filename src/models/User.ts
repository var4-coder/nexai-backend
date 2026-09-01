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
  passwordHash?: string;
  googleId?: string;
  role: UserRole;
  plan: UserPlan;
  trialEndsAt?: Date;
  creditsBalance: number;
  /** Nombre de noms de domaine (GoDaddy) déjà obtenus via le quota inclus du plan */
  domainsUsed: number;
  /** Nombre de logos déjà consommés via le quota inclus du plan (Agence 2 / Pro Max 3) */
  logosUsed: number;
  ipHash?: string;
  /**
   * Mode d'encaissement par défaut pour les sites :
   * - lien_personnel : le client met son lien de paiement (ex. page Chariow)
   * - nexai : encaissement via le compte NexAI, puis reversement (interne)
   * Valeur stockée côté site : lien_personnel | chariow (chariow = nexai, non exposé au client)
   */
  defaultPaymentMode?: 'lien_personnel' | 'nexai';
  /** Lien de paiement personnel (ex. URL page Chariow du client) */
  personalPaymentLink?: string;
  /** Prestataire déclaré pour le lien personnel — libellé d'affichage uniquement, aucune règle technique différente selon la valeur */
  personalPaymentProvider?: 'chariow' | 'maketou' | 'stripe' | 'autre';
  compteReversement?: {
    /** mobile_money | crypto */
    type?: 'mobile_money' | 'crypto';
    operateur?: string; // Wave, Orange Money, MTN, Moov…
    numero?: string;
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
    passwordHash: { type: String, select: false },
    googleId: { type: String, index: true, sparse: true, unique: true },
    role: { type: String, enum: ['user', 'admin', 'finance', 'support'], default: 'user' },
    plan: { type: String, enum: ['trial', 'starter', 'createur', 'agence', 'pro_max'], default: 'trial' },
    trialEndsAt: { type: Date },
    creditsBalance: { type: Number, default: 0, min: 0 },
    domainsUsed: { type: Number, default: 0, min: 0 },
    logosUsed: { type: Number, default: 0, min: 0 },
    ipHash: { type: String },
    defaultPaymentMode: {
      type: String,
      enum: ['lien_personnel', 'nexai'],
      default: 'nexai',
    },
    personalPaymentLink: { type: String },
    personalPaymentProvider: { type: String, enum: ['chariow', 'maketou', 'stripe', 'autre'] },
    compteReversement: {
      type: { type: String, enum: ['mobile_money', 'crypto'] },
      operateur: { type: String },
      numero: { type: String },
      cryptoAddress: { type: String },
    },
    emailVerifiedAt: { type: Date },
    // Code de vérification email (Brevo) — jamais le mot de passe, effacé une fois vérifié
    emailVerification: {
      codeHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
      attempts: { type: Number, default: 0, select: false },
      lastSentAt: { type: Date, select: false },
    },
    // Code de réinitialisation de mot de passe (Brevo) — même schéma que la vérification email
    passwordReset: {
      codeHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
      attempts: { type: Number, default: 0, select: false },
      lastSentAt: { type: Date, select: false },
    },
  },
  { timestamps: true }
);

// Essai 7 jours : max 3 comptes par IP (A.7.1 / règle freemium)
userSchema.index({ ipHash: 1 });

export const User = model<IUser>('User', userSchema);
