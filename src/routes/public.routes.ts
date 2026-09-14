import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Site } from '@/models/Site';
import { SiteSubmission } from '@/models/SiteSubmission';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { hashIp } from '@/utils/crypto';
import { sendLeadNotificationEmail } from '@/services/brevo.service';
import { enregistrerVisite } from '@/services/site-visits.service';

/**
 * Backend public consommé par les sites CLIENTS livrés (HTML statique ou
 * Next.js), potentiellement depuis n'importe quel nom de domaine — voir la
 * config CORS dédiée dans app.ts pour ce préfixe. Authentification légère
 * par clé publique par site (x-nexai-site-key), pas par JWT utilisateur :
 * ce sont des visiteurs anonymes du site du client, pas des comptes NexAI.
 */
export const publicRouter = Router();

// Limite dédiée, plus stricte que la limite globale, pour éviter le spam de
// formulaires depuis un site client (par IP, tous sites confondus).
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Trop de soumissions, réessayez plus tard.' } },
});

const submitSchema = z.object({
  type: z.enum(['contact', 'reservation', 'commande', 'avis', 'autre']).default('contact'),
  data: z.record(z.unknown()).refine((d) => Object.keys(d).length > 0, 'Données manquantes'),
});

publicRouter.post(
  '/sites/:siteId/submit',
  submitLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const siteKey = req.headers['x-nexai-site-key'];
      if (!siteKey || typeof siteKey !== 'string') {
        throw new AppError('Clé de site manquante', 401);
      }

      const site = await Site.findById(req.params.siteId);
      if (!site || !site.publicApiKey || site.publicApiKey !== siteKey) {
        throw new AppError('Site introuvable ou clé invalide', 401);
      }
      if (site.status !== 'launched') {
        throw new AppError("Ce site n'est pas en ligne actuellement", 403);
      }

      const body = submitSchema.parse(req.body);

      const submission = await SiteSubmission.create({
        siteId: site._id,
        type: body.type,
        data: body.data,
        ipHash: req.ip ? hashIp(req.ip) : undefined,
        userAgent: req.headers['user-agent'],
      });

      // Notification email best-effort — ne bloque jamais la réponse au visiteur.
      User.findById(site.userId)
        .then((owner) => {
          if (owner?.email) {
            return sendLeadNotificationEmail(owner.email, site.name || String(site._id), body.type, body.data);
          }
        })
        .catch((err) => console.error('[public.routes] notification email échouée', err));

      res.status(201).json({ ok: true, submissionId: submission._id });
    } catch (err) {
      next(err);
    }
  }
);

export default publicRouter;

/**
 * POST /visite — page vue d'un site client déployé.
 *
 * Appelée par le script injecté dans les sites en ligne. Route publique et
 * volontairement permissive : elle répond toujours 204, même en cas de
 * problème, pour ne jamais faire apparaître d'erreur dans la console du
 * visiteur ni ralentir le site du client.
 */
publicRouter.post('/visite', async (req: Request, res: Response) => {
  // Réponse immédiate : l'enregistrement se poursuit en arrière-plan.
  res.status(204).end();

  try {
    const siteId = String(req.body?.siteId ?? '');
    if (!siteId || !/^[0-9a-f]{24}$/i.test(siteId)) return;

    await enregistrerVisite({
      siteId,
      chemin: typeof req.body?.chemin === 'string' ? req.body.chemin : '/',
      // L'IP sert uniquement à calculer une empreinte anonyme, elle n'est
      // jamais stockée (voir site-visits.service.ts).
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '',
      userAgent: String(req.headers['user-agent'] ?? ''),
      referer: typeof req.body?.referer === 'string' ? req.body.referer : undefined,
      pays: (req.headers['cf-ipcountry'] as string) || undefined,
    });
  } catch {
    // Silencieux : une statistique perdue ne doit jamais remonter au visiteur.
  }
});
