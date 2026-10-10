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
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    next(new AppError('Token invalide ou expiré', 401));
  }
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
