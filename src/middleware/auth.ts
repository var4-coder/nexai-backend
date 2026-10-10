import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { AppError } from './errorHandler';
import type { UserRole } from '@/models/User';

export interface AuthPayload {
  userId: string;
  role: UserRole;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
      /**
       * Corps brut (octets) de la requête, capturé par le middleware
       * express.json() via son option `verify` (voir app.ts). Nécessaire
       * pour vérifier les signatures HMAC de webhooks (ex: Chariow) sur les
       * octets réellement envoyés, plutôt que sur un JSON reparsé qui peut
       * différer du corps d'origine.
       */
      rawBody?: Buffer;
    }
  }
}

/**
 * Vérifie le JWT httpOnly et attache le payload décodé à req.auth.
 * Implémentation complète du flux d'auth prévue en Phase 1 - étape 2.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return next(new AppError('Authentification requise', 401));
  }
  let payload: AuthPayload & { iat?: number };
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthPayload & { iat?: number };
  } catch {
    return next(new AppError('Token invalide ou expiré', 401));
  }
  // Session encore valable ? Compte supprimé, ou mot de passe changé depuis
  // l'ouverture de la session → refusée (un jeton volé ne survit pas à un
  // changement de mot de passe). Petit cache de 30 s pour ne pas interroger
  // la base à chaque requête.
  sessionValide(payload.userId, payload.iat)
    .then((ok) => {
      if (!ok) return next(new AppError('Session expirée. Reconnectez-vous.', 401));
      req.auth = payload;
      next();
    })
    .catch(next);
}

const cacheSessions = new Map<string, { revoqueLe: number | null; existe: boolean; lu: number }>();
async function sessionValide(userId: string, iat?: number): Promise<boolean> {
  let etat = cacheSessions.get(userId);
  if (!etat || Date.now() - etat.lu > 30_000) {
    const { User } = await import('@/models/User');
    const u = await User.findById(userId).select('sessionsRevoqueesLe').lean<{ sessionsRevoqueesLe?: Date }>();
    etat = { existe: !!u, revoqueLe: u?.sessionsRevoqueesLe ? new Date(u.sessionsRevoqueesLe).getTime() : null, lu: Date.now() };
    cacheSessions.set(userId, etat);
    if (cacheSessions.size > 20_000) cacheSessions.clear();
  }
  if (!etat.existe) return false;
  if (etat.revoqueLe && (iat ?? 0) * 1000 < etat.revoqueLe) return false;
  return true;
}

/** À appeler après un changement de mot de passe : la règle s'applique sans attendre le cache. */
export function oublierSession(userId: string) {
  cacheSessions.delete(userId);
}

/**
 * Réservé à certains rôles. Le rôle est relu en base à chaque requête : un
 * jeton reste valable 7 jours, et un compte retiré (associé supprimé, rôle
 * changé) ne doit pas garder ses accès jusqu'à son expiration.
 */
export function requireRole(...roles: UserRole[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(new AppError('Accès refusé', 403));
    }
    try {
      const { User } = await import('@/models/User');
      const actuel = await User.findById(req.auth.userId).select('role').lean<{ role?: UserRole }>();
      if (!actuel?.role || !roles.includes(actuel.role)) return next(new AppError('Accès refusé', 403));
      req.auth.role = actuel.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
