import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { CreditsService, PLAN_CREDITS, PLAN_PRICES_FCFA, PLAN_LABELS } from '@/services/credits.service';
import { AppError } from '@/middleware/errorHandler';

export const plansRouter = Router();

/** Liste publique des plans payants disponibles (prix + crédits inclus). */
plansRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const plans = (Object.keys(PLAN_PRICES_FCFA) as Array<keyof typeof PLAN_PRICES_FCFA>).map(
      (id) => ({
        id,
        label: PLAN_LABELS[id],
        priceFCFA: PLAN_PRICES_FCFA[id],
        credits: PLAN_CREDITS[id],
        current: user.plan === id,
      })
    );

    res.json({ plans, currentPlan: user.plan });
  } catch (err) {
    next(err);
  }
});

/**
 * Initie un changement d'abonnement via Chariow — ne change PAS le plan
 * immédiatement. Le changement est appliqué au webhook (type plan_purchase).
 */
plansRouter.post('/acheter', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        targetPlan: z.enum(['starter', 'createur', 'agence', 'pro_max']),
        currency: z.enum(['XOF', 'USD']).optional().default('XOF'),
      })
      .parse(req.body);

    const result = await CreditsService.purchasePlanUpgrade(
      String(req.auth!.userId),
      body.targetPlan,
      body.currency
    );

    res.status(201).json({
      ok: true,
      pending: true,
      message: 'Lien de paiement généré. Le changement de plan sera appliqué après confirmation du paiement.',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});  
