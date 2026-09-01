import { Router, Request, Response, NextFunction } from 'express';
import { verifyChariowSignature, handleChariowWebhook } from '@/services/chariow.service';
import { AppError } from '@/middleware/errorHandler';

export const webhooksRouter = Router();

webhooksRouter.post('/chariow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-chariow-signature'] as string | undefined;

    // Vérifie la signature sur les octets bruts reçus (capturés par
    // express.json({ verify }) dans app.ts), jamais sur une resérialisation
    // JS de req.body qui peut différer de l'original (ordre des clés,
    // formatage des nombres, échappement Unicode) et invalider une signature
    // pourtant valide — ou pire, en valider une invalide par coïncidence.
    if (!req.rawBody) {
      throw new AppError('Corps de requête brut indisponible pour la vérification de signature', 400);
    }
    const raw = req.rawBody.toString('utf8');

    if (!verifyChariowSignature(raw, signature)) {
      throw new AppError('Signature Chariow invalide', 401);
    }

    const payload = {
      reference: String(req.body.reference || req.body.id || ''),
      montant: Number(req.body.montant || req.body.amount || 0),
      statut: String(req.body.statut || req.body.status || ''),
      site_id: req.body.site_id || req.body.metadata?.site_id,
      metadata: req.body.metadata,
    };

    if (!payload.reference || !payload.montant) {
      throw new AppError('Payload Chariow incomplet', 400);
    }

    const paiement = await handleChariowWebhook(payload);
    res.status(200).json({ ok: true, paiementId: paiement._id });
  } catch (err) {
    next(err);
  }
});
