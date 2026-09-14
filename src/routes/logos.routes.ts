import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { Site } from '@/models/Site';
import { Job } from '@/models/Job';
import { Logo } from '@/models/Logo';
import { pipelineQueue } from '@/jobs/queue';
import { debitCredits, creditCredits, CREDIT_COSTS, getLogoQuotaInfo } from '@/services/credits.service';
import { generateLogoProposals, generateEmbellishmentImage } from '@/services/recraft.service';
import { AppError } from '@/middleware/errorHandler';

export const logosRouter = Router();

const PLANS_EMBELLISSEMENT = new Set(['agence', 'pro_max']);

/**
 * Bibliothèque de logos du compte — pour proposer "logo déjà créé ici ?"
 * dans l'étape logo du chat (Partie D — point 6), au lieu de forcer une
 * nouvelle génération à chaque site.
 */
logosRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logos = await Logo.find({ userId: req.auth!.userId }).sort({ createdAt: -1 }).limit(50);
    res.json({ logos });
  } catch (err) {
    next(err);
  }
});

/**
 * Génération de 3 logos (Recraft) — abonnés payants, 5 crédits.
 * Source de Vérité A.4 + C.2.
 */
logosRouter.post('/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial' || user.plan === 'starter') {
      throw new AppError('La génération de logo est réservée aux plans Créateur, Agence et Pro Max.', 403);
    }

    const body = z
      .object({
        brandName: z.string().min(1),
        niche: z.string().min(1),
        styleHints: z.string().optional(),
        colors: z.string().optional(),
        siteId: z.string().optional(),
      })
      .parse(req.body);

    // Quota logos inclus (Agence 2 / Pro Max 3) — gratuit tant qu'il reste du quota
    const quota = getLogoQuotaInfo(user.plan, user.logosUsed || 0);
    let creditsSpent = 0;
    let usedIncludedQuota = false;
    if (quota.canUseIncluded) {
      user.logosUsed = (user.logosUsed || 0) + 1;
      await user.save();
      creditsSpent = 0;
      usedIncludedQuota = true;
    } else {
      await debitCredits(user._id, CREDIT_COSTS.LOGO, 'logo', {
        relatedSiteId: body.siteId,
        note: `logos:${body.brandName}`,
      });
      creditsSpent = CREDIT_COSTS.LOGO;
    }

    let proposals: Awaited<ReturnType<typeof generateLogoProposals>>;
    try {
      proposals = await generateLogoProposals({
        brandName: body.brandName,
        niche: body.niche,
        styleHints: body.styleHints,
        colors: body.colors,
      });
    } catch (genErr) {
      // Aucune image valide obtenue (voir recraft.service.ts) : on rembourse
      // ce qui a été consommé plutôt que de faire perdre du quota/crédits
      // au client pour un logo qu'il n'a jamais reçu.
      if (usedIncludedQuota) {
        user.logosUsed = Math.max(0, (user.logosUsed || 0) - 1);
        await user.save();
      } else if (creditsSpent > 0) {
        await creditCredits(user._id, creditsSpent, 'ajustement_admin', {
          relatedSiteId: body.siteId,
          note: 'remboursement_logo_genération_echouee',
        });
      }
      throw genErr;
    }

    // Persistance en bibliothèque (compte) — indépendant du site pour lequel
    // c'est généré, réutilisable ensuite pour n'importe quel site futur.
    await Logo.insertMany(
      proposals.map((p) => ({
        userId: user._id,
        siteId: body.siteId,
        brandName: body.brandName,
        niche: body.niche,
        url: p.url,
        prompt: p.prompt,
        source: 'generated' as const,
      }))
    );

    // Optionnel : rattacher au site
    if (body.siteId) {
      const site = await Site.findById(body.siteId);
      if (site && String(site.userId) === String(user._id)) {
        (site as unknown as { logoProposals?: typeof proposals }).logoProposals = proposals;
        await site.save();
      }
    }

    res.status(201).json({ proposals, creditsSpent, logosRemaining: Math.max(0, quota.remaining - (creditsSpent === 0 ? 1 : 0)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Réutiliser un logo déjà présent dans la bibliothèque du compte pour un
 * site donné — pas de nouvelle génération, pas de débit.
 */
logosRouter.post('/:id/choisir', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logo = await Logo.findById(req.params.id);
    if (!logo || String(logo.userId) !== String(req.auth!.userId)) {
      throw new AppError('Logo introuvable', 404);
    }
    const body = z.object({ siteId: z.string().min(1) }).parse(req.body);
    const site = await Site.findById(body.siteId);
    if (!site || String(site.userId) !== String(req.auth!.userId)) {
      throw new AppError('Site introuvable', 404);
    }
    site.chosenLogoUrl = logo.url;
    await site.save();
    await Logo.updateMany({ userId: req.auth!.userId }, { chosen: false });
    logo.chosen = true;
    await logo.save();
    res.json({ site, logo });
  } catch (err) {
    next(err);
  }
});

/**
 * Enregistre dans la bibliothèque un logo propre au client (fichier envoyé
 * depuis le chat, déjà uploadé — voir routes/chat.routes.ts POST /:id/upload
 * qui renvoie une URL Cloudinary). Ne débite aucun crédit : ce n'est pas une
 * génération IA.
 */
logosRouter.post('/importer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        url: z.string().url(),
        brandName: z.string().min(1),
        niche: z.string().optional(),
        siteId: z.string().optional(),
      })
      .parse(req.body);

    const logo = await Logo.create({
      userId: req.auth!.userId,
      siteId: body.siteId,
      brandName: body.brandName,
      niche: body.niche,
      url: body.url,
      source: 'uploaded',
    });

    if (body.siteId) {
      const site = await Site.findById(body.siteId);
      if (site && String(site.userId) === String(req.auth!.userId)) {
        site.chosenLogoUrl = body.url;
        await site.save();
      }
    }

    res.status(201).json({ logo });
  } catch (err) {
    next(err);
  }
});

/**
 * Embellissement site : image avec logo en fond OU image décorative.
 * UNIQUEMENT plans Agence et Pro Max.
 */
logosRouter.post(
  '/embellissement',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.auth!.userId);
      if (!user) throw new AppError('Utilisateur introuvable', 404);

      if (!PLANS_EMBELLISSEMENT.has(user.plan)) {
        throw new AppError(
          'L\'embellissement du site avec logo (fond ou image décorative) est réservé aux plans Agence et Pro Max.',
          403
        );
      }

      const body = z
        .object({
          brandName: z.string().min(1),
          niche: z.string().min(1),
          logoDescription: z.string().min(1),
          mode: z.enum(['background', 'decorative']),
          siteId: z.string().optional(),
        })
        .parse(req.body);

      // Coût aligné sur une génération image (réutilise coût logo ou 5 crédits)
      await debitCredits(user._id, CREDIT_COSTS.LOGO, 'logo', {
        relatedSiteId: body.siteId,
        note: `embellissement:${body.mode}`,
      });

      let image: Awaited<ReturnType<typeof generateEmbellishmentImage>>;
      try {
        image = await generateEmbellishmentImage({
          brandName: body.brandName,
          niche: body.niche,
          logoDescription: body.logoDescription,
          mode: body.mode,
        });
      } catch (genErr) {
        // Aucune image valide obtenue : on rembourse plutôt que de faire
        // perdre des crédits au client pour rien.
        await creditCredits(user._id, CREDIT_COSTS.LOGO, 'ajustement_admin', {
          relatedSiteId: body.siteId,
          note: 'remboursement_embellissement_genération_echouee',
        });
        throw genErr;
      }

      res.status(201).json({
        mode: body.mode,
        imageUrl: image.url,
        creditsSpent: CREDIT_COSTS.LOGO,
        planRequired: ['agence', 'pro_max'],
      });
    } catch (err) {
      next(err);
    }
  }
);
