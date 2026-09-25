import jwt from 'jsonwebtoken';
import type { CookieOptions } from 'express';
import { env, isProd } from '@/config/env';
import type { UserRole } from '@/models/User';

export interface AuthTokenPayload {
  userId: string;
  role: UserRole;
  email: string;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Parse une durée style "7d" / "15m" / "12h" / "30s" en millisecondes.
 * Retombe sur 7 jours si le format n'est pas reconnu.
 */
function parseDurationToMs(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(duration.trim());
  const FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
  if (!match) return FALLBACK_MS;

  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (unitMs[match[2].toLowerCase()] ?? unitMs.d);
}

export const AUTH_COOKIE_NAME = 'token';

export const authCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  maxAge: parseDurationToMs(env.JWT_EXPIRES_IN),
  path: '/',
};
