import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '@/middleware/errorHandler';
import { requireAuth } from '@/middleware/auth';
import { AUTH_COOKIE_NAME, authCookieOptions } from '@/utils/jwt';
import {
  registerUser,
  verifyEmailCode,
  resendVerificationCode,
  loginUser,
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
  email: z.string().email(),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
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

authRouter.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = parseOrThrow(registerSchema, req.body);
    const user = await registerUser({ email, password, ip: req.ip });
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
    const { user, token } = await loginUser({ email, password });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { idToken } = parseOrThrow(googleSchema, req.body);
    const { user, token } = await loginWithGoogle({ idToken, ip: req.ip });
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
    res.json({ message: 'Mot de passe mis à jour.' });
  } catch (err) {
    next(err);
  }
});
