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
  prenom?: string;
  nom?: string;
  passwordHash?: string;
  googleId?: string;
  role: UserRole;
  plan: UserPlan;
  trialEndsAt?: Date;
  creditsBalance: number;
  domainsUsed: number;
  logosUsed: number;
  ipHash?: string;
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
    prenom: { type: String },
    nom: { type: String },
    passwordHash: { type: String, select: false },
    googleId: { type: String, index: true, sparse: true, unique: true },
    role: { type: String, enum: ['user', 'admin', 'finance', 'support'], default: 'user' },
    plan: { type: String, enum: ['trial', 'starter', 'createur', 'agence', 'pro_max'], default: 'trial' },
    trialEndsAt: { type: Date },
    creditsBalance: { type: Number, default: 0, min: 0 },
    domainsUsed: { type: Number, default: 0, min: 0 },
    logosUsed: { type: Number, default: 0, min: 0 },
    ipHash: { type: String },
    themePreference: { type: String, enum: ['sombre', 'clair'], default: 'sombre' },
    entrepriseNom: { type: String },
    deviceFingerprint: { type: String, index: true },
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredByCode: { type: String },
    referredByUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    referralRewardGranted: { type: Boolean, default: false },
    videoTestUsed: { type: Boolean, default: false },
    videoTestVideoAdId: { type: Schema.Types.ObjectId, ref: 'VideoAd' },
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
