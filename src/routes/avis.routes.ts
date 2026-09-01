import { Router, Request, Response, NextFunction } from 'express';
import { Avis } from '@/models/Avis';

/**
 * Avis publics pour la landing — uniquement active: true.
 * Pas d'auth requise.
 */
export const avisRouter = Router();

avisRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const avis = await Avis.find({ active: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(50);
    res.json({ avis });
  } catch (err) {
    next(err);
  }
});
