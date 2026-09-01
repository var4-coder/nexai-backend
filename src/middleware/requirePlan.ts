import { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler';
import { User, UserPlan } from '@/models/User';

/**
 * Vérifie que l'utilisateur authentifié a un plan autorisé (ex: Espace
 * Agence réservé à `agence` / `pro_max`). Le JWT (req.auth) ne contient pas
 * le plan — on va le chercher en base à chaque requête pour refléter un
 * changement d'abonnement immédiatement (pas de cache côté token).
 * À utiliser après `requireAuth`.
 */
export function requirePlan(...allowedPlans: UserPlan[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        return next(new AppError('Authentification requise', 401));
      }
      const user = await User.findById(req.auth.userId).select('plan');
      if (!user) {
        return next(new AppError('Utilisateur introuvable', 404));
      }
      if (!allowedPlans.includes(user.plan)) {
        return next(
          new AppError(
            "Cette fonctionnalité est réservée aux plans Agence et Pro Max. Passez à l'un de ces plans pour continuer.",
            403
          )
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
