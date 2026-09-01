import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { CreditTransaction } from '@/models/CreditTransaction';

export const usersRouter = Router();

usersRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        plan: user.plan,
        trialEndsAt: user.trialEndsAt,
        creditsBalance: user.creditsBalance,
        domainsUsed: user.domainsUsed ?? 0,
        logosUsed: user.logosUsed ?? 0,
        hasGoogle: Boolean(user.googleId),
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        defaultPaymentMode: user.defaultPaymentMode || 'nexai',
        personalPaymentLink: user.personalPaymentLink || '',
        personalPaymentProvider: user.personalPaymentProvider || '',
        compteReversement: user.compteReversement || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Solde + historique des transactions de crédits (achat de packs réservé aux
// abonnés — jamais en essai gratuit, voir A.11).
usersRouter.get('/me/credits', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const transactions = await CreditTransaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      balance: user.creditsBalance,
      plan: user.plan,
      canPurchase: user.plan !== 'trial',
      transactions,
    });
  } catch (err) {
    next(err);
  }
});


/**
 * Réglages d'encaissement des paiements sur les sites clients.
 * - lien_personnel : le client fournit son lien (recommandé : page Chariow)
 * - nexai : encaissement via NexAI puis reversement (Mobile Money ou crypto)
 *   (implémentation interne non exposée au client)
 */
usersRouter.patch('/me/payments', requireAuth, async (req, res, next) => {
  try {
    
    const body = z
      .object({
        defaultPaymentMode: z.enum(['lien_personnel', 'nexai']),
        personalPaymentLink: z.string().url().optional().or(z.literal('')),
        personalPaymentProvider: z.enum(['chariow', 'maketou', 'stripe', 'autre']).optional(),
        compteReversement: z
          .object({
            type: z.enum(['mobile_money', 'crypto']),
            operateur: z.string().optional(),
            numero: z.string().optional(),
            cryptoAddress: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    if (body.defaultPaymentMode === 'lien_personnel') {
      const link = (body.personalPaymentLink || '').trim();
      if (!link) {
        throw new AppError(
          'Indiquez le lien de votre page de paiement (ex. votre page Chariow).',
          400
        );
      }
      user.defaultPaymentMode = 'lien_personnel';
      user.personalPaymentLink = link;
      user.personalPaymentProvider = body.personalPaymentProvider;
    } else {
      const rev = body.compteReversement;
      if (!rev) {
        throw new AppError('Renseignez vos coordonnées de reversement (Mobile Money ou crypto).', 400);
      }
      if (rev.type === 'mobile_money') {
        if (!rev.operateur?.trim() || !rev.numero?.trim()) {
          throw new AppError('Opérateur et numéro Mobile Money requis.', 400);
        }
      }
      if (rev.type === 'crypto') {
        if (!rev.cryptoAddress?.trim()) {
          throw new AppError('Adresse crypto requise.', 400);
        }
      }
      user.defaultPaymentMode = 'nexai';
      user.compteReversement = {
        type: rev.type,
        operateur: rev.operateur?.trim(),
        numero: rev.numero?.trim(),
        cryptoAddress: rev.cryptoAddress?.trim(),
      };
    }

    await user.save();

    res.json({
      ok: true,
      defaultPaymentMode: user.defaultPaymentMode,
      personalPaymentLink: user.personalPaymentLink || '',
      personalPaymentProvider: user.personalPaymentProvider || '',
      compteReversement: user.compteReversement || null,
      // Mapping interne site.paymentMode : nexai → chariow (non exposé)
      sitePaymentMode: user.defaultPaymentMode === 'nexai' ? 'chariow' : 'lien_personnel',
    });
  } catch (err) {
    next(err);
  }
});
