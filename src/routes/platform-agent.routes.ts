import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { PlatformAlert } from '@/models/PlatformAlert';
import { getTachesApprouvees } from '@/services/platform-alert.service';

export const platformAgentRouter = Router();

/**
 * Routes destinées à l'agent de maintenance externe de l'administrateur
 * (compte Console, avec accès Git — ce que ce backend n'a pas).
 *
 * SÉCURITÉ — points volontaires :
 *  - Jeton dédié (PLATFORM_AGENT_TOKEN), JAMAIS le JWT admin. Si le jeton
 *    de l'agent fuite, le compte administrateur reste intact.
 *  - Comparaison à temps constant : empêche de deviner le jeton caractère
 *    par caractère en mesurant le temps de réponse.
 *  - L'agent ne voit QUE les incidents approuvés par l'administrateur.
 *    Il ne peut ni lister les comptes, ni toucher aux données clients.
 *  - Sans jeton configuré, ces routes sont totalement fermées.
 */
function requireAgentToken(req: Request, _res: Response, next: NextFunction) {
  const attendu = env.PLATFORM_AGENT_TOKEN;
  if (!attendu) {
    return next(new AppError('Agent de maintenance non configuré.', 503));
  }
  const fourni = String(req.headers['x-agent-token'] ?? '');
  const a = Buffer.from(fourni);
  const b = Buffer.from(attendu);
  // Longueurs différentes : refus immédiat, sans fuite d'information utile.
  if (a.length !== b.length) {
    return next(new AppError('Accès refusé.', 403));
  }
  const crypto = require('crypto') as typeof import('crypto');
  if (!crypto.timingSafeEqual(a, b)) {
    return next(new AppError('Accès refusé.', 403));
  }
  next();
}

platformAgentRouter.use(requireAgentToken);

/** GET /tasks — incidents approuvés, prêts à être réparés. */
platformAgentRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ taches: await getTachesApprouvees() });
  } catch (err) {
    next(err);
  }
});

/** POST /tasks/:id/start — l'agent prend l'incident en charge. */
platformAgentRouter.post('/tasks/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const inc = await PlatformAlert.findById(req.params.id);
    if (!inc) throw new AppError('Incident introuvable.', 404);
    if (inc.statut !== 'approuve') {
      throw new AppError("Cet incident n'a pas été approuvé par l'administrateur.", 409);
    }
    inc.statut = 'en_reparation';
    await inc.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /tasks/:id/report — compte-rendu de réparation. */
platformAgentRouter.post('/tasks/:id/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        compteRendu: z.string().min(5).max(4000),
        resolu: z.boolean().default(true),
      })
      .parse(req.body);

    const inc = await PlatformAlert.findById(req.params.id);
    if (!inc) throw new AppError('Incident introuvable.', 404);

    inc.compteRenduAgent = body.compteRendu;
    // Si l'agent n'a pas résolu, l'incident retourne en attente de décision
    // plutôt que d'être clos à tort.
    inc.statut = body.resolu ? 'resolu' : 'diagnostique';
    if (body.resolu) inc.resoluA = new Date();
    await inc.save();

    res.json({ ok: true, statut: inc.statut });
  } catch (err) {
    next(err);
  }
});
