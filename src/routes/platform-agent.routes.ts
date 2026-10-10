import { sendAgentNotificationEmail } from '@/services/brevo.service';
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

/** GET /tasks/:id/etat — l'erreur se reproduit-elle encore ? (vérification après réparation) */
platformAgentRouter.get('/tasks/:id/etat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const inc = await PlatformAlert.findById(req.params.id).select('statut occurrences derniereOccurrence reparation commitValide pointDeRetour').lean();
    if (!inc) throw new AppError('Incident introuvable.', 404);
    res.json({
      statut: inc.statut,
      occurrences: inc.occurrences,
      derniereOccurrence: inc.derniereOccurrence,
      enLigneA: inc.reparation?.enLigneA ?? null,
      commitValide: inc.commitValide ?? null,
      pointDeRetour: inc.pointDeRetour ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /tasks/:id/start — l'agent prend l'incident en charge. */
platformAgentRouter.post('/tasks/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Point de retour OBLIGATOIRE : la version qui tourne avant toute
    // modification. Sans lui, l'agent ne peut pas commencer.
    const body = z
      .object({
        pointDeRetour: z.object({
          commitServeur: z.string().min(4).max(80),
          deployServeur: z.string().max(80).optional(),
          deploySite: z.string().max(80).optional(),
        }),
      })
      .parse(req.body ?? {});
    const inc = await PlatformAlert.findOneAndUpdate(
      { _id: req.params.id, statut: 'approuve' },
      {
        $set: { statut: 'en_reparation', pointDeRetour: { ...body.pointDeRetour, noteA: new Date() } },
        $inc: { essaisAgent: 1 },
        $unset: { retourArriere: 1, reparation: 1 },
      },
      { new: true }
    );
    if (!inc) throw new AppError("Cet incident n'est pas approuvé, ou déjà pris en charge.", 409);
    res.json({ ok: true, essai: inc.essaisAgent });
  } catch (err) {
    next(err);
  }
});

/** POST /tasks/:id/en-ligne — la correction vient d'être mise en ligne (versions déployées). */
platformAgentRouter.post('/tasks/:id/en-ligne', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        commitServeur: z.string().max(80).optional(),
        deployServeur: z.string().max(80).optional(),
        deploySite: z.string().max(80).optional(),
      })
      .parse(req.body ?? {});
    const inc = await PlatformAlert.findOneAndUpdate(
      { _id: req.params.id, statut: 'en_reparation' },
      { $set: { reparation: { ...body, enLigneA: new Date() } } },
      { new: true }
    );
    if (!inc) throw new AppError('Incident introuvable ou pas en réparation.', 404);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /tasks/:id/proposition — correction prête, en attente de validation par l'admin (rien en ligne). */
platformAgentRouter.post('/tasks/:id/proposition', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        url: z.string().url().max(300),
        numero: z.number().int().positive(),
        resume: z.string().min(3).max(3800),
        fichiers: z.array(z.string().max(200)).max(20),
      })
      .parse(req.body ?? {});
    const inc = await PlatformAlert.findOneAndUpdate(
      { _id: req.params.id, statut: 'en_reparation' },
      { $set: { statut: 'a_valider', proposition: { ...body, proposeeA: new Date() }, compteRenduAgent: body.resume } },
      { new: true }
    );
    if (!inc) throw new AppError('Incident introuvable ou pas en réparation.', 404);
    sendAgentNotificationEmail({
      titre: 'Correction prête : à valider',
      texte: `L’agent a préparé une correction pour « ${inc.composant} ». Rien n’est en ligne : validez-la ou refusez-la depuis l’administration. Résumé : ${body.resume.slice(0, 600)}`,
      alerteId: String(inc._id),
    }).catch(() => undefined);
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
        /** Vrai si l'agent a remis la version d'avant (correction mauvaise ou insuffisante). */
        retourArriere: z.boolean().default(false),
      })
      .parse(req.body);

    const inc = await PlatformAlert.findById(req.params.id);
    if (!inc) throw new AppError('Incident introuvable.', 404);

    inc.compteRenduAgent = body.compteRendu;
    if (body.retourArriere) inc.retourArriere = { par: 'agent', le: new Date(), detail: body.compteRendu.slice(0, 500) };
    if (!body.resolu) {
      sendAgentNotificationEmail({
        titre: body.retourArriere ? 'Réparation annulée : tout est revenu comme avant' : 'L’agent n’a pas pu réparer',
        texte: body.compteRendu.slice(0, 800),
        alerteId: String(inc._id),
      }).catch(() => undefined);
    }
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
