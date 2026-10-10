import { verifierCaptcha } from '@/services/captcha.service';
import { Router } from 'express';
import { sourceDe } from '@/services/stats-jour.service';
import { User } from '@/models/User';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '@/middleware/errorHandler';
import { requireAuth, oublierSession } from '@/middleware/auth';
import { AUTH_COOKIE_NAME, authCookieOptions } from '@/utils/jwt';
import {
  registerUser,
  verifyEmailCode,
  resendVerificationCode,
  loginUser,
  loginAvecCode,
  issueToken,
  loginWithGoogle,
  requestPasswordReset,
  resetPassword,
  changePassword,
} from '@/services/auth.service';

export const authRouter = Router();

// Limite dédiée sur les endpoints sensibles (au-delà du rate limit global) —
// protège contre le bruteforce de mot de passe / code de vérification.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Trop de tentatives, réessayez plus tard.' } },
});

const registerSchema = z.object({
  /** Jeton du captcha Turnstile (si activé). */
  captchaToken: z.string().max(4096).optional(),
  email: z.string().email(),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
  /**
   * Pays choisi au formulaire, code ISO à 2 lettres. Sert à déduire la langue
   * d'interface par défaut du compte (voir langueParDefautPourPays).
   * Facultatif : un compte sans pays reste en français.
   */
  pays: z.string().length(2).optional(),
  /** Code de parrainage saisi (ou repris du lien d'invitation ?ref=). Un code invalide est ignoré. */
  referralCode: z.string().trim().max(20).optional(),
  /** Empreinte navigateur — protège le parrainage contre l'auto-parrainage. */
  deviceFingerprint: z.string().trim().max(128).optional(),
  /** D'où vient l'inscrit (lien de pub : utm_source, ou site d'origine) — Bilan de l'admin. */
  source: z.string().trim().max(60).optional(),
  campagne: z.string().trim().max(80).optional(),
});

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

const resendSchema = z.object({
  email: z.string().email(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const googleSchema = z.object({
  idToken: z.string().min(1),
  referralCode: z.string().trim().max(20).optional(),
  deviceFingerprint: z.string().trim().max(128).optional(),
  pays: z.string().length(2).optional(),
  source: z.string().trim().max(60).optional(),
  campagne: z.string().trim().max(80).optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
});

function parseOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(result.error.issues[0]?.message ?? 'Requête invalide', 400);
  }
  return result.data;
}

/** Source de l'inscrit, notée une seule fois (à la création du compte). */
async function noterAcquisition(userId: string | undefined, source?: string, campagne?: string) {
  if (!userId || !/^[0-9a-f]{24}$/i.test(userId)) return;
  await User.updateOne(
    { _id: userId, 'acquisition.source': { $exists: false } },
    { $set: { acquisition: { source: sourceDe(source), campagne: campagne || undefined, le: new Date() } } }
  ).catch(() => {});
}

authRouter.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password, pays, referralCode, deviceFingerprint, source, campagne, captchaToken } = parseOrThrow(registerSchema, req.body);
    await verifierCaptcha(captchaToken, req.ip);
    const user = await registerUser({ email, password, pays, referralCode, deviceFingerprint, ip: req.ip });
    await noterAcquisition((user as { id?: string; _id?: unknown }).id ?? String((user as { _id?: unknown })._id), source, campagne);
    res.status(201).json({
      message: 'Compte créé. Un code de vérification a été envoyé par email.',
      user,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/verify-email', authLimiter, async (req, res, next) => {
  try {
    const { email, code } = parseOrThrow(verifySchema, req.body);
    const { user, token } = await verifyEmailCode({ email, code });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/resend-code', authLimiter, async (req, res, next) => {
  try {
    const { email } = parseOrThrow(resendSchema, req.body);
    await resendVerificationCode(email);
    // Réponse volontairement générique : on ne confirme jamais si l'email existe.
    res.json({ message: 'Si un compte existe, un nouveau code a été envoyé.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = parseOrThrow(loginSchema, req.body);
    const resultat = await loginUser({ email, password });
    if ('deuxEtapes' in resultat) {
      // Administration : mot de passe correct, un code a été envoyé par email.
      return res.json({ deuxEtapes: true, message: 'Un code de connexion vient de vous être envoyé par email.' });
    }
    res.cookie(AUTH_COOKIE_NAME, resultat.token, authCookieOptions);
    res.json({ user: resultat.user, token: resultat.token });
  } catch (err) {
    next(err);
  }
});

/** Deuxième étape de connexion de l'administration : code reçu par email. */
authRouter.post('/login/code', authLimiter, async (req, res, next) => {
  try {
    const { email, code } = parseOrThrow(
      z.object({ email: z.string().email(), code: z.string().trim().regex(/^\d{6}$/, 'Le code contient 6 chiffres.') }),
      req.body
    );
    const { user, token } = await loginAvecCode({ email, code });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { idToken, referralCode, deviceFingerprint, pays, source, campagne } = parseOrThrow(googleSchema, req.body);
    const { user, token } = await loginWithGoogle({ idToken, referralCode, deviceFingerprint, pays, ip: req.ip });
    await noterAcquisition((user as { id?: string; _id?: unknown }).id ?? String((user as { _id?: unknown })._id), source, campagne);
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  res.json({ message: 'Déconnecté.' });
});

// --- Mot de passe oublié ---
authRouter.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = parseOrThrow(forgotPasswordSchema, req.body);
    await requestPasswordReset(email);
    // Réponse volontairement générique : ne révèle jamais si l'email existe
    // ni si le compte est Google-only (sans mot de passe).
    res.json({ message: 'Si un compte existe, un code de réinitialisation a été envoyé.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { email, code, newPassword } = parseOrThrow(resetPasswordSchema, req.body);
    const { user, token } = await resetPassword({ email, code, newPassword });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

// --- Changement de mot de passe (utilisateur connecté) ---
authRouter.post('/change-password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = parseOrThrow(changePasswordSchema, req.body);
    await changePassword({ userId: req.auth!.userId, currentPassword, newPassword });
    oublierSession(req.auth!.userId);
    // Les autres sessions sont fermées ; celle-ci reçoit un nouveau jeton.
    const { User } = await import('@/models/User');
    const u = await User.findById(req.auth!.userId);
    const token = u ? issueToken(u) : undefined;
    if (token) res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ message: 'Mot de passe mis à jour. Vos autres appareils ont été déconnectés.', token });
  } catch (err) {
    next(err);
  }
});
