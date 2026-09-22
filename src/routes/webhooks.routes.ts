import { Router, Request, Response, NextFunction } from 'express';
import {
  verifyChariowSignature,
  handleChariowWebhook,
  normalizeChariowWebhookBody,
} from '@/services/chariow.service';
import { AppError } from '@/middleware/errorHandler';

export const webhooksRouter = Router();

webhooksRouter.post('/chariow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-chariow-signature'] as string | undefined;

    if (!req.rawBody) {
      throw new AppError('Corps de requête brut indisponible pour la vérification de signature', 400);
    }
    const raw = req.rawBody.toString('utf8');

    if (!verifyChariowSignature(raw, signature)) {
      throw new AppError('Signature Chariow invalide', 401);
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const payload = normalizeChariowWebhookBody(body);

    if (!payload.reference) {
      throw new AppError('Payload Chariow incomplet (référence manquante)', 400);
    }

    const paiement = await handleChariowWebhook(payload);

    if (!paiement) {
      res.status(200).json({ ok: true, ignored: true, reason: 'statut_non_abouti' });
      return;
    }

    res.status(200).json({ ok: true, paiementId: paiement._id });
  } catch (err) {
    next(err);
  }
});
