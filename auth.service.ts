import type { HydratedDocument } from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import { User, IUser } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { env } from '@/config/env';
import { hashIp, generateVerificationCode, hashValue, compareValue } from '@/utils/crypto';
import { signAuthToken } from '@/utils/jwt';
import { sendVerificationCodeEmail, sendPasswordResetCodeEmail } from './brevo.service';

// Règles freemium/essai — voir Partie A.7.1 / A.11 de la Source de Vérité
const MAX_ACCOUNTS_PER_IP = 3;
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
}): Promise<SafeUser> {
  const email = params.email.toLowerCase().trim();

  const existing = await User.findOne({ email });
  if (existing) {
    throw new AppError('Un compte existe déjà avec cet email.', 409);
  }

  const ipHash = await assertIpNotOverLimit(params.ip);
  const passwordHash = await hashValue(params.password);
  const isAdmin = email === env.ADMIN_EMAIL;

  const user = await User.create({
    email,
    passwordHash,
    role: isAdmin ? 'admin' : 'user',
    plan: isAdmin ? 'pro_max' : 'trial',
    trialEndsAt: isAdmin ? undefined : newTrialEndsAt(),
    creditsBalance: isAdmin ? 999999 : 12, // admin = crédits illimités (en pratique), essai = 12 crédits
    domainsUsed: 0,
    ipHash,
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
    const isAdmin = email === env.ADMIN_EMAIL;
    user = await User.create({
      email,
      googleId,
      role: isAdmin ? 'admin' : 'user',
      plan: isAdmin ? 'pro_max' : 'trial',
      trialEndsAt: isAdmin ? undefined : newTrialEndsAt(),
      creditsBalance: isAdmin ? 999999 : 12, // admin = crédits illimités (en pratique), même essai sinon
      domainsUsed: 0,
      ipHash,
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
    '+passwordReset.lastSentAt +passwordHash'
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
  if (!reset || !reset.expiresAt || reset.expiresAt.getTime() < Date.now()) {
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
