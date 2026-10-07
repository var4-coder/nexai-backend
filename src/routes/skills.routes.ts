import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { CREDIT_COSTS, SKILL_ALLOWED_PLANS } from '@/services/credits.service';
import { fichierMonSkill, listerMesCommandes, relancerCommande } from '@/services/skill-nexai.service';

/**
 * Skill NexAI côté client : prix, accès, suivi des commandes, téléchargement.
 * La création passe par le chat (mode « skill », voir chat.service.ts).
 */
export const skillsRouter = Router();

/** GET /info — prix et droit d'accès du client (l'écran est visible par tous les plans). */
skillsRouter.get('/info', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    res.json({
      prixCredits: CREDIT_COSTS.SKILL_NEXAI,
      acces: user.role === 'admin' || SKILL_ALLOWED_PLANS.has(user.plan),
      planMinimum: 'createur',
    });
  } catch (err) {
    next(err);
  }
});

/** GET /mine — mes skills commandés, avec l'avancement en 5 étapes. */
skillsRouter.get('/mine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ commandes: await listerMesCommandes(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});

/** POST /mine/:requestId/relancer — second essai gratuit, 30 min après l'échec du premier. */
skillsRouter.post('/mine/:requestId/relancer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(202).json(await relancerCommande(req.auth!.userId, req.params.requestId));
  } catch (err) {
    next(err);
  }
});

/** GET /mine/:skillId/:type — téléchargement (zip | guide | preuve | acoller). */
skillsRouter.get('/mine/:skillId/:type', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = z.enum(['zip', 'guide', 'preuve', 'acoller']).parse(req.params.type);
    const f = await fichierMonSkill(req.auth!.userId, req.params.skillId, type);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${f.nom}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.buffer);
  } catch (err) {
    next(err);
  }
});

export default skillsRouter;
