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
   * Préférence d'apparence de l'interface — choix du client, persisté pour
   * qu'il retrouve son réglage sur tous ses appareils. Le thème clair n'est
   * proposé que dans les pages internes de l'app : l'accueil public, la
   * connexion et l'inscription restent toujours sombres (identité de marque).
   */
  themePreference?: 'sombre' | 'clair';
  /** Nom d'entreprise, affiché sur les reçus Agence/Pro Max (section 17) */
  entrepriseNom?: string;
  /**
   * Empreinte appareil/navigateur — protection anti-fraude transverse
   * (parrainage, test vidéo essai). Ne remplace jamais ipHash : plusieurs
   * vrais clients partagent souvent la même IP dans les marchés visés
   * (cybercafé, réseau mobile partagé), l'empreinte est plus discriminante.
   */
  deviceFingerprint?: string;

  // ── Parrainage (Architecture v6, section 16) ──────────────────
  /** Code personnel du client, à partager. Généré à l'inscription. */
  referralCode?: string;
  /** Code du parrain, saisi par CE client à son inscription (optionnel). */
  referredByCode?: string;
  /** Parrain résolu à partir de referredByCode — figé à l'inscription. */
  referredByUserId?: Types.ObjectId;
  /**
   * Passe à true une fois la récompense versée au parrain, à la PREMIÈRE
   * conversion payante de ce filleul. Garde d'idempotence : empêche de
   * récompenser deux fois le même filleul (renouvellement, changement de
   * plan, webhook rejoué…).
   */
  referralRewardGranted?: boolean;

  /**
   * « Tester Vidéo IA » — essai gratuit, une seule fois par compte
   * (Architecture v6, section 7). Passe à true dès la première génération :
   * le bouton reste visible ensuite mais verrouillé, avec un message
   * d'upsell vers l'abonnement.
   */
  videoTestUsed?: boolean;
  /** Identifiant de la vidéo de test, pour la rejouer en streaming. */
  videoTestVideoAdId?: Types.ObjectId;
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
    /** Précision du réseau — critique : envoyer sur le mauvais réseau perd les fonds. */
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
