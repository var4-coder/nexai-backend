import type { HydratedDocument } from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import { User, IUser } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import {
  langueParDefautPourPays,
  normaliserLangue,
  isPaysSupporte,
  type Langue,
} from '@/constants/pays';
import { env } from '@/config/env';
import { hashIp, generateVerificationCode, hashValue, compareValue } from '@/utils/crypto';
import { signAuthToken } from '@/utils/jwt';
import { sendVerificationCodeEmail, sendPasswordResetCodeEmail } from './brevo.service';
import { PLAN_CREDITS } from '@/services/credits.service';
import { estEmailJetable, MESSAGE_EMAIL_JETABLE } from '@/services/disposable-email.service';
import { emailEstAdmin } from '@/services/admin-security.service';
import { generateUniqueReferralCode, resolveReferralCode } from '@/services/referral.service';

// Règles freemium/essai — voir Partie A.7.1 / A.11 de la Source de Vérité
const MAX_ACCOUNTS_PER_IP = 3;
/**
 * Comptes maximum par appareil. Complémentaire à la limite par IP : dans
 * les marchés visés, beaucoup de vrais clients partagent une même IP
 * (cybercafé, réseau mobile), alors qu'un même navigateur créant plusieurs
 * comptes d'essai est un signal bien plus fiable.
 */
const MAX_ACCOUNTS_PER_DEVICE = 2;

async function assertDeviceNotOverLimit(fingerprint?: string): Promise<void> {
  if (!fingerprint) return; // empreinte absente : on ne bloque pas
  const count = await User.countDocuments({ deviceFingerprint: fingerprint });
  if (count >= MAX_ACCOUNTS_PER_DEVICE) {
    throw new AppError(
      "Plusieurs comptes ont déjà été créés depuis cet appareil. Connectez-vous à votre compte existant ou contactez l'assistance.",
      429
    );
  }
}
const TRIAL_DURATION_DAYS = 7;
const CODE_TTL_MINUTES = 15;
const CODE_RESEND_COOLDOWN_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;

const googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

export interface SafeUser {
  id: string;
  email: string;
  role: IUser['role'];
  plan: IUser['plan'];
  trialEndsAt?: Date;
  creditsBalance: number;
  domainsUsed?: number;
  /** Langue d'interface du compte (déduite du pays, modifiable). */
  langue?: Langue;
  /** Pays du compte (code ISO 2 lettres). */
  telephonePays?: string;
  emailVerifiedAt?: Date;
  createdAt: Date;
}

type UserDoc = HydratedDocument<IUser>;

function toSafeUser(user: UserDoc): SafeUser {
  return {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    plan: user.plan,
    trialEndsAt: user.trialEndsAt,
    creditsBalance: user.creditsBalance,
    domainsUsed: user.domainsUsed ?? 0,
    langue: (user.langue as Langue) ?? 'fr',
    telephonePays: user.telephonePays,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

function issueToken(user: UserDoc): string {
  return signAuthToken({ userId: user._id.toString(), role: user.role, email: user.email });
}

function newTrialEndsAt(): Date {
  return new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

async function assertIpNotOverLimit(ip: string | undefined): Promise<string | undefined> {
  if (!ip) return undefined;
  const ipHash = hashIp(ip);
  const count = await User.countDocuments({ ipHash });
  if (count >= MAX_ACCOUNTS_PER_IP) {
    throw new AppError('Limite de comptes atteinte pour cette connexion (essai gratuit).', 429);
  }
  return ipHash;
}

async function issueVerificationCode(user: UserDoc): Promise<void> {
  const code = generateVerificationCode();
  const codeHash = await hashValue(code);

  user.emailVerification = {
    codeHash,
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
    attempts: 0,
    lastSentAt: new Date(),
  };
  await user.save();

  await sendVerificationCodeEmail(user.email, code);
}

export async function registerUser(params: {
  email: string;
  password: string;
  ip?: string;
  /** Code de parrainage saisi à l'inscription (champ optionnel du formulaire) */
  referralCode?: string;
  /** Empreinte appareil/navigateur — anti-fraude parrainage et test vidéo */
  deviceFingerprint?: string;
  /**
   * Pays choisi au formulaire (code ISO 2 lettres). Sert à déduire la langue
   * d'interface par défaut — voir langueParDefautPourPays.
   */
  pays?: string;
  /** Langue explicitement demandée, si le formulaire la propose. */
  langue?: string;
}): Promise<SafeUser> {
  const email = params.email.toLowerCase().trim();

  const existing = await User.findOne({ email });
  if (existing) {
    throw new AppError('Un compte existe déjà avec cet email.', 409);
  }

  if (estEmailJetable(email)) {
    throw new AppError(MESSAGE_EMAIL_JETABLE, 400);
  }

  const ipHash = await assertIpNotOverLimit(params.ip);
  await assertDeviceNotOverLimit(params.deviceFingerprint);
  const passwordHash = await hashValue(params.password);

  // Parrainage : un code invalide n'empêche JAMAIS la création du compte —
  // il est simplement ignoré (voir resolveReferralCode). La récompense du
  // parrain n'est versée qu'à la première conversion payante de ce filleul.
  const referredByUserId = await resolveReferralCode(params.referralCode);

  const user = await User.create({
    email,
    passwordHash,
    role: (await emailEstAdmin(email)) ? 'admin' : 'user',
    // Le compte admin est forcé en pro_max : son rôle lui donne des crédits
    // illimités (bypass sur debitCredits), mais les restrictions de PLAN
    // restent actives partout ailleurs (mise en ligne, logo, Espace Agence).
    // Sans ce forçage, l'admin serait bloqué comme un compte d'essai.
    plan: (await emailEstAdmin(email)) ? 'pro_max' : 'trial',
    trialEndsAt: (await emailEstAdmin(email)) ? undefined : newTrialEndsAt(),
    creditsBalance: PLAN_CREDITS.trial, // 15 crédits offerts, une seule fois
    domainsUsed: 0,
    // Langue d'interface : celle demandée explicitement, sinon déduite du pays
    // choisi, sinon français. Modifiable ensuite dans Paramètres.
    langue:
      normaliserLangue(params.langue) ?? langueParDefautPourPays(params.pays),
    telephonePays: isPaysSupporte(params.pays)
      ? params.pays!.toUpperCase()
      : undefined,
    ipHash,
    deviceFingerprint: params.deviceFingerprint,
    referralCode: await generateUniqueReferralCode(),
    referredByCode: params.referralCode?.trim().toUpperCase(),
    referredByUserId,
    referralRewardGranted: false,
  });

  await issueVerificationCode(user);

  return toSafeUser(user);
}

export async function resendVerificationCode(email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
    '+emailVerification.lastSentAt'
  );
  if (!user) {
    // On ne révèle pas si l'email existe ou non.
    return;
  }
  if (user.emailVerifiedAt) {
    throw new AppError('Cet email est déjà vérifié.', 400);
  }

  const lastSentAt = user.emailVerification?.lastSentAt;
  if (lastSentAt && Date.now() - lastSentAt.getTime() < CODE_RESEND_COOLDOWN_SECONDS * 1000) {
    throw new AppError('Merci de patienter avant de redemander un code.', 429);
  }

  await issueVerificationCode(user);
}

export async function verifyEmailCode(params: {
  email: string;
  code: string;
}): Promise<{ user: SafeUser; token: string }> {
  const user = await User.findOne({ email: params.email.toLowerCase().trim() }).select(
    '+emailVerification.codeHash +emailVerification.expiresAt +emailVerification.attempts +emailVerification.lastSentAt'
  );

  if (!user) {
    throw new AppError('Code invalide ou expiré.', 400);
  }

  if (user.emailVerifiedAt) {
    return { user: toSafeUser(user), token: issueToken(user) };
  }

  const verification = user.emailVerification;
  if (!verification || verification.expiresAt.getTime() < Date.now()) {
    throw new AppError('Code invalide ou expiré. Redemandez un code.', 400);
  }

  if (verification.attempts >= MAX_CODE_ATTEMPTS) {
    throw new AppError('Trop de tentatives. Redemandez un nouveau code.', 429);
  }

  const isValid = await compareValue(params.code, verification.codeHash);
  if (!isValid) {
    verification.attempts += 1;
    await user.save();
    throw new AppError('Code invalide ou expiré.', 400);
  }

  user.emailVerifiedAt = new Date();
  user.emailVerification = undefined;
  await user.save();

  return { user: toSafeUser(user), token: issueToken(user) };
}

export async function loginUser(params: {
  email: string;
  password: string;
}): Promise<{ user: SafeUser; token: string }> {
  const user = await User.findOne({ email: params.email.toLowerCase().trim() }).select('+passwordHash');

  if (!user || !user.passwordHash) {
    throw new AppError('Identifiants invalides.', 401);
  }

  const isValid = await compareValue(params.password, user.passwordHash);
  if (!isValid) {
    throw new AppError('Identifiants invalides.', 401);
  }

  if (!user.emailVerifiedAt) {
    throw new AppError('Email non vérifié. Vérifiez votre boîte mail.', 403);
  }

  return { user: toSafeUser(user), token: issueToken(user) };
}

export async function loginWithGoogle(params: {
  idToken: string;
  ip?: string;
  /** Uniquement utilisés à la PREMIÈRE connexion (création du compte) */
  referralCode?: string;
  deviceFingerprint?: string;
  pays?: string;
  langue?: string;
}): Promise<{ user: SafeUser; token: string }> {
  if (!googleClient || !env.GOOGLE_CLIENT_ID) {
    throw new AppError('Connexion Google non configurée.', 501);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: params.idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AppError('Jeton Google invalide.', 401);
  }

  if (!payload?.email) {
    throw new AppError('Jeton Google invalide.', 401);
  }

  const email = payload.email.toLowerCase().trim();
  const googleId = payload.sub;

  let user = await User.findOne({ $or: [{ googleId }, { email }] });

  if (!user) {
    const ipHash = await assertIpNotOverLimit(params.ip);
    user = await User.create({
      email,
      googleId,
      role: (await emailEstAdmin(email)) ? 'admin' : 'user',
      plan: (await emailEstAdmin(email)) ? 'pro_max' : 'trial',
      trialEndsAt: (await emailEstAdmin(email)) ? undefined : newTrialEndsAt(),
      creditsBalance: PLAN_CREDITS.trial, // 15 crédits, identique à l'inscription email
      domainsUsed: 0,
      langue:
        normaliserLangue(params.langue) ?? langueParDefautPourPays(params.pays),
      telephonePays: isPaysSupporte(params.pays)
        ? params.pays!.toUpperCase()
        : undefined,
      ipHash,
      deviceFingerprint: params.deviceFingerprint,
      referralCode: await generateUniqueReferralCode(),
      referredByCode: params.referralCode?.trim().toUpperCase(),
      referredByUserId: await resolveReferralCode(params.referralCode),
      referralRewardGranted: false,
      emailVerifiedAt: new Date(), // Google a déjà vérifié l'email
    });
  } else {
    let changed = false;
    if (!user.googleId) {
      user.googleId = googleId;
      changed = true;
    }
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date();
      changed = true;
    }
    if (changed) await user.save();
  }

  return { user: toSafeUser(user), token: issueToken(user) };
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
    '+passwordReset.lastSentAt'
  );
  // Réponse toujours générique côté route : on ne révèle jamais si l'email
  // existe, ni si le compte est Google-only (pas de mot de passe).
  if (!user || !user.passwordHash) return;

  const lastSentAt = user.passwordReset?.lastSentAt;
  if (lastSentAt && Date.now() - lastSentAt.getTime() < CODE_RESEND_COOLDOWN_SECONDS * 1000) {
    return;
  }

  const code = generateVerificationCode();
  const codeHash = await hashValue(code);

  user.passwordReset = {
    codeHash,
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
    attempts: 0,
    lastSentAt: new Date(),
  };
  await user.save();

  await sendPasswordResetCodeEmail(user.email, code);
}

export async function resetPassword(params: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ user: SafeUser; token: string }> {
  const user = await User.findOne({ email: params.email.toLowerCase().trim() }).select(
    '+passwordReset.codeHash +passwordReset.expiresAt +passwordReset.attempts +passwordReset.lastSentAt +passwordHash'
  );

  if (!user) {
    throw new AppError('Code invalide ou expiré.', 400);
  }

  const reset = user.passwordReset;
  if (!reset || reset.expiresAt.getTime() < Date.now()) {
    throw new AppError('Code invalide ou expiré. Redemandez un code.', 400);
  }

  if (reset.attempts >= MAX_CODE_ATTEMPTS) {
    throw new AppError('Trop de tentatives. Redemandez un nouveau code.', 429);
  }

  const isValid = await compareValue(params.code, reset.codeHash);
  if (!isValid) {
    reset.attempts += 1;
    await user.save();
    throw new AppError('Code invalide ou expiré.', 400);
  }

  user.passwordHash = await hashValue(params.newPassword);
  user.passwordReset = undefined;
  await user.save();

  return { user: toSafeUser(user), token: issueToken(user) };
}

export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user || !user.passwordHash) {
    throw new AppError('Changement de mot de passe indisponible pour ce compte.', 400);
  }

  const isValid = await compareValue(params.currentPassword, user.passwordHash);
  if (!isValid) {
    throw new AppError('Mot de passe actuel incorrect.', 401);
  }

  user.passwordHash = await hashValue(params.newPassword);
  await user.save();
}
