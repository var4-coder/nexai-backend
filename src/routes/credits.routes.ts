import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { CREDIT_PACKS, CreditsService } from '@/services/credits.service';
import { AppError } from '@/middleware/errorHandler';

export const creditsRouter = Router();

/** Liste des packs (abonnés uniquement) */
creditsRouter.get('/packs', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan creditsBalance');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial') {
      throw new AppError('Achat de crédits impossible en essai 7 jours. Passez à un abonnement.', 403);
    }
    res.json({ packs: CREDIT_PACKS, balance: user.creditsBalance });
  } catch (err) {
    next(err);
  }
});

/**
 * Initie un achat de pack via Chariow — ne crédite PAS immédiatement.
 * Le crédit arrive au webhook (type credit_purchase).
 */
creditsRouter.post('/acheter', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial') {
      throw new AppError('Achat de crédits impossible en essai 7 jours. Passez à un abonnement.', 403);
    }

    const body = z
      .object({
        packId: z.string().optional(),
        quantity: z.number().int().min(10).max(200).optional(),
        currency: z.enum(['XOF', 'USD']).optional().default('XOF'),
      })
      .parse(req.body);

    let quantity = body.quantity;
    if (body.packId) {
      const pack = CREDIT_PACKS.find((p) => p.id === body.packId);
      if (!pack) throw new AppError('Pack introuvable', 404);
      quantity = pack.credits;
    }
    if (!quantity) {
      throw new AppError('Indiquez un packId ou une quantity (10–200).', 400);
    }

    const result = await CreditsService.purchaseCreditPack(
      String(user._id),
      quantity,
      body.currency
    );

    res.status(201).json({
      ok: true,
      pending: true,
      message: 'Lien de paiement généré. Les crédits seront ajoutés après confirmation du paiement.',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});
