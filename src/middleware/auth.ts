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

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(new AppError('Accès refusé', 403));
    }
    next();
  };
}
