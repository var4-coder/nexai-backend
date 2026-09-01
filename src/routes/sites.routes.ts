import { Router, Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { Site, SiteNiche } from '@/models/Site';
import { SiteSubmission } from '@/models/SiteSubmission';
import { Client } from '@/models/Client';
import {
  enqueueSiteGeneration,
  chooseProposal,
  enqueueLaunch,
  enqueueAiModify,
} from '@/services/ia-pipeline.service';
import { AppError } from '@/middleware/errorHandler';
import { User } from '@/models/User';

export const sitesRouter = Router();

const nicheEnum = z.enum([
  'hotellerie_evenementiel',
  'sante_bienetre',
  'immobilier_architecture',
  'services_locaux',
  'business_vitrine',
  'ecommerce_mode',
  'portfolio_creatif',
  'tech_startup_saas',
  'restaurant_gastronomie',
  'education_formation',
]);

sitesRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'starter') {
      throw new AppError(
        "Le plan Starter est réservé à l'Académie. Passez à Créateur pour créer des sites.",
        403
      );
    }

    const body = z
      .object({
        niche: nicheEnum,
        brief: z.record(z.unknown()).default({}),
        name: z.string().trim().min(1).max(120).optional(),
        // Uniquement pour les sites créés depuis l'Espace Agence (plans agence/pro_max).
        clientId: z.string().optional(),
        // 'static' (défaut) = HTML généré par le pipeline IA. 'nextjs' = projet Next.js
        // buildé et déployé au lancement, pour les sites complexes nécessitant un vrai
        // backend applicatif (voir jobs/worker.ts + services/nextjs-pipeline.service.ts).
        siteType: z.enum(['static', 'nextjs']).optional().default('static'),
      })
      .parse(req.body);

    let clientId: Types.ObjectId | undefined;
    if (body.clientId) {
      if (user.plan !== 'agence' && user.plan !== 'pro_max') {
        throw new AppError(
          'Le rattachement à un client est réservé aux plans Agence et Pro Max.',
          403
        );
      }
      if (!Types.ObjectId.isValid(body.clientId)) {
        throw new AppError('Client introuvable', 404);
      }
      const client = await Client.findOne({ _id: body.clientId, agencyUserId: req.auth!.userId });
      if (!client) throw new AppError('Client introuvable', 404);
      clientId = client._id;
    }

    // Nom d'affichage : fourni ou dérivé du brief / niche
    const briefName =
      typeof body.brief?.brandName === 'string'
        ? body.brief.brandName
        : typeof body.brief?.name === 'string'
          ? body.brief.name
          : undefined;

    const site = await Site.create({
      userId: req.auth!.userId,
      clientId,
      niche: body.niche as SiteNiche,
      name: body.name || briefName || undefined,
      brief: body.brief,
      status: 'brief_incomplete',
      siteType: body.siteType,
      proposals: [],
      capacites: [],
    });

    res.status(201).json({ site });
  } catch (err) {
    next(err);
  }
});

sitesRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sites = await Site.find({ userId: req.auth!.userId })
      .select('-proposals.htmlDemo -proposals.pages.html')
      .sort({ updatedAt: -1 });
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

sitesRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(req.auth!.userId) && req.auth!.role !== 'admin') {
      throw new AppError('Accès refusé', 403);
    }
    res.json({ site });
  } catch (err) {
    next(err);
  }
});

sitesRouter.patch('/:id/brief', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(req.auth!.userId)) throw new AppError('Accès refusé', 403);

    const body = z.object({ brief: z.record(z.unknown()) }).parse(req.body);
    site.brief = { ...site.brief, ...body.brief };
    // Mise à jour name si brandName fourni
    const bn = body.brief.brandName ?? body.brief.name;
    if (typeof bn === 'string' && bn.trim() && !site.name) {
      site.name = bn.trim();
    }
    await site.save();
    res.json({ site });
  } catch (err) {
    next(err);
  }
});

sitesRouter.post('/:id/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        qualityTier: z.enum(['normal', 'premium']).optional().default('normal'),
      })
      .parse(req.body ?? {});

    const result = await enqueueSiteGeneration(req.params.id, req.auth!.userId, body.qualityTier);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

sitesRouter.post('/:id/choose', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Frontend peut envoyer proposalIndex (0-based) ou versionId (prop_1…)
    const body = z
      .object({
        versionId: z.string().optional(),
        proposalIndex: z.number().int().min(0).optional(),
      })
      .parse(req.body);

    let versionId = body.versionId;
    if (!versionId && body.proposalIndex != null) {
      versionId = `prop_${body.proposalIndex + 1}`;
    }
    if (!versionId) {
      throw new AppError('Indiquez versionId ou proposalIndex', 400);
    }

    const site = await chooseProposal(req.params.id, req.auth!.userId, versionId);
    // Optionnel : name à partir de la proposition / brief
    if (!site.name) {
      const bn = (site.brief as { brandName?: string })?.brandName;
      if (bn) {
        site.name = bn;
        await site.save();
      }
    }
    res.json({ site });
  } catch (err) {
    next(err);
  }
});

sitesRouter.post('/:id/lancer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        domainType: z.enum(['sous_domaine', 'godaddy', 'byod']),
        domainName: z.string().optional(),
        subdomainSlug: z
          .string()
          .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/i, 'Slug invalide (lettres, chiffres, tirets)')
          .optional(),
        paymentMode: z.enum(['lien_personnel', 'chariow']),
        paymentLink: z.string().url().optional(),
        paymentProvider: z.enum(['chariow', 'maketou', 'stripe', 'autre']).optional(),
      })
      .parse(req.body);

    const result = await enqueueLaunch(req.params.id, req.auth!.userId, body);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Mettre hors ligne / remettre en ligne un site déjà lancé.
 * POST /sites/:id/offline  body: { offline?: boolean }  (défaut true)
 */
sitesRouter.post('/:id/offline', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(req.auth!.userId) && req.auth!.role !== 'admin') {
      throw new AppError('Accès refusé', 403);
    }

    const body = z
      .object({ offline: z.boolean().optional().default(true) })
      .parse(req.body ?? {});

    if (body.offline) {
      if (site.status !== 'launched' && site.status !== 'offline') {
        throw new AppError('Seuls les sites lancés peuvent être mis hors ligne.', 400);
      }
      site.status = 'offline';
    } else {
      if (site.status !== 'offline') {
        throw new AppError('Ce site n\'est pas hors ligne.', 400);
      }
      site.status = 'launched';
    }
    await site.save();
    res.json({ site });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH status générique (alternative à /offline)
 */
sitesRouter.patch('/:id/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(req.auth!.userId) && req.auth!.role !== 'admin') {
      throw new AppError('Accès refusé', 403);
    }

    const body = z
      .object({ status: z.enum(['launched', 'offline']) })
      .parse(req.body);

    if (body.status === 'offline') {
      if (site.status !== 'launched' && site.status !== 'offline') {
        throw new AppError('Seuls les sites lancés peuvent être mis hors ligne.', 400);
      }
    } else if (body.status === 'launched') {
      if (site.status !== 'offline' && site.status !== 'launched') {
        throw new AppError('Impossible de passer en launched depuis cet état.', 400);
      }
    }
    site.status = body.status;
    await site.save();
    res.json({ site });
  } catch (err) {
    next(err);
  }
});

/**
 * Messages/réservations/commandes reçus depuis le site livré (backend public).
 * GET /sites/:id/submissions?type=contact&status=nouveau
 */
sitesRouter.get('/:id/submissions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(req.auth!.userId) && req.auth!.role !== 'admin') {
      throw new AppError('Accès refusé', 403);
    }

    const query = z
      .object({
        type: z.enum(['contact', 'reservation', 'commande', 'avis', 'autre']).optional(),
        status: z.enum(['nouveau', 'lu', 'traite', 'spam']).optional(),
      })
      .parse(req.query);

    const filter: Record<string, unknown> = { siteId: site._id };
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;

    const submissions = await SiteSubmission.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ submissions });
  } catch (err) {
    next(err);
  }
});

/**
 * Modification IA — coût 5 crédits.
 * Body: { instruction: string }
 */
sitesRouter.post('/:id/ai-modify', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({ instruction: z.string().min(5).max(2000) })
      .parse(req.body);
    const result = await enqueueAiModify(req.params.id, req.auth!.userId, body.instruction);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
