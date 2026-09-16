import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { Site } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';
import { env } from '@/config/env';
import { checkDomainAvailability } from '@/services/godaddy.service';
import {
  getDomainQuotaInfo,
  getDomainPriceCredits,
} from '@/services/credits.service';

export const domainsRouter = Router();

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Un sous-domaine est-il déjà pris par un AUTRE site actif ? */
async function isSubdomainSlugTaken(slug: string, excludeSiteId?: string): Promise<boolean> {
  const domain = `${slug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`;
  const query: Record<string, unknown> = {
    domainName: domain,
    status: { $in: ['launched', 'generating'] },
  };
  if (excludeSiteId) query._id = { $ne: excludeSiteId };
  const conflict = await Site.exists(query);
  return Boolean(conflict);
}

/**
 * Vérifie la disponibilité d'un sous-domaine NexAI gratuit souhaité.
 * Aucune restriction de plan : accessible même en essai gratuit.
 */
domainsRouter.post('/sous-domaine/check', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ slug: z.string().min(1).max(60) }).parse(req.body);
    const slug = normalizeSlug(body.slug);
    if (!slug) throw new AppError('Nom de sous-domaine invalide après normalisation.', 400);

    const taken = await isSubdomainSlugTaken(slug);
    res.json({
      slug,
      domain: `${slug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`,
      available: !taken,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Propose des variantes disponibles d'un sous-domaine NexAI gratuit, si le
 * nom souhaité par le client est déjà pris par un autre compte. Simple
 * vérification d'unicité interne (pas d'appel GoDaddy — ce n'est pas un
 * vrai nom de domaine, seulement un sous-domaine NexAI).
 */
domainsRouter.post(
  '/sous-domaine/variantes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ base: z.string().min(1).max(60) }).parse(req.body);
      const base = normalizeSlug(body.base);
      if (!base) throw new AppError('Nom de sous-domaine invalide après normalisation.', 400);

      const suffixes = ['', '-2', '-3', '-officiel', '-site', '-pro', '-ci', '-shop'];
      const candidates = Array.from(
        new Set(suffixes.map((suf) => `${base.slice(0, 40 - suf.length)}${suf}`))
      );

      const variants: { slug: string; domain: string; available: boolean }[] = [];
      for (const slug of candidates) {
        const taken = await isSubdomainSlugTaken(slug);
        variants.push({ slug, domain: `${slug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`, available: !taken });
        if (variants.filter((v) => v.available).length >= 5) break;
      }

      res.json({ variants });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Quota domaines du client connecté (pour le frontend page Domaine).
 */
domainsRouter.get('/quota', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan domainsUsed creditsBalance');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const info = getDomainQuotaInfo(user.plan, user.domainsUsed ?? 0);
    res.json({
      plan: user.plan,
      included: info.included,
      used: info.used,
      remaining: info.remaining,
      canUseIncluded: info.canUseIncluded,
      creditCostIfExtra: info.creditCostIfExtra,
      creditsBalance: user.creditsBalance,
      // Options affichables côté client (sans jargon interne)
      options: {
        sous_domaine: {
          label: 'Sous-domaine NexAI',
          free: true,
          description: 'Votre site accessible via un sous-domaine NexAI (inclus).',
        },
        godaddy: {
          label: 'Obtenir ou acheter un nom de domaine',
          partner: 'GoDaddy',
          freeIfQuota: info.canUseIncluded,
          // Pas de prix générique ici : le coût réel dépend du domaine choisi
          // (prix GoDaddy exact + 5cr), calculé par /domains/check une fois
          // le nom recherché — voir getDomainPriceCredits.
          creditCost: info.canUseIncluded ? 0 : null,
          description:
            'Nom de domaine personnalisé via notre partenaire. Inclus dans votre abonnement si quota restant, sinon prix exact GoDaddy converti en crédits (+5cr de marge).',
        },
        byod: {
          label: 'Utiliser mon propre domaine',
          free: true,
          description:
            'Si vous avez déjà un nom de domaine, renseignez-le au lancement du site.',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

function resolvePriceCredits(
  plan: string,
  domainsUsed: number,
  creditsBalance: number,
  priceUsd: number | null
): { priceCredits: number; canAfford: boolean } {
  const info = getDomainQuotaInfo(plan as import('@/models/User').UserPlan, domainsUsed);
  // Prix réel GoDaddy converti + 5cr de marge (voir getDomainPriceCredits) —
  // jamais un forfait fixe : si GoDaddy n'a pas renvoyé de prix exploitable
  // (devise inattendue…), on refuse explicitement plutôt que d'inventer un prix.
  const priceCredits = info.canUseIncluded ? 0 : priceUsd !== null ? getDomainPriceCredits(priceUsd) : null;
  const canAfford = priceCredits === null ? false : priceCredits === 0 || creditsBalance >= priceCredits;
  return { priceCredits: priceCredits ?? 0, canAfford };
}

/**
 * Vérifie la disponibilité d'un nom de domaine (GoDaddy).
 * Réponse enrichie : { domain, available, priceCredits }
 * Pas de débit ici — le débit se fait uniquement au lancer / confirmation.
 */
domainsRouter.post('/check', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        domain: z
          .string()
          .min(3)
          .max(253)
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Nom de domaine invalide'),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId).select('plan domainsUsed creditsBalance role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.role !== 'admin' && (user.plan === 'trial' || user.plan === 'starter')) {
      throw new AppError(
        'La vérification de domaine est réservée aux abonnés pouvant créer un site.',
        403
      );
    }

    const domain = body.domain.toLowerCase().trim();
    let available = false;
    let priceUsd: number | null = null;
    try {
      const result = await checkDomainAvailability(domain);
      available = result.available;
      priceUsd = result.priceUsd;
    } catch {
      throw new AppError(
        'Impossible de vérifier ce domaine pour le moment. Réessayez dans un instant.',
        502
      );
    }

    const { priceCredits, canAfford } = resolvePriceCredits(
      user.plan,
      user.domainsUsed ?? 0,
      user.creditsBalance ?? 0,
      priceUsd
    );

    // Anti-faillite informatif (pas de débit ici)
    if (available && !canAfford && user.role !== 'admin') {
      // On renvoie quand même available + priceCredits ; le frontend peut bloquer
      // Le lancer refusera explicitement si solde insuffisant
    }

    res.json({ domain, available, priceCredits });
  } catch (err) {
    next(err);
  }
});

/**
 * Génère 3–5 variantes de nom de domaine à partir d'une base.
 * Body: { base: string }
 * Réponse: { variants: [{ domain, available, priceCredits }] }
 */
domainsRouter.post('/variants', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        base: z
          .string()
          .min(2)
          .max(60)
          .transform((s) =>
            s
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9-]/g, '')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '')
          ),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId).select('plan domainsUsed creditsBalance role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.role !== 'admin' && (user.plan === 'trial' || user.plan === 'starter')) {
      throw new AppError(
        'Les variantes de domaine sont réservées aux abonnés pouvant créer un site.',
        403
      );
    }

    const base = body.base;
    if (base.length < 2) {
      throw new AppError('Base de domaine trop courte après normalisation.', 400);
    }

    // 5 extensions officielles NexAI (Architecture v6, section 11) — jamais
    // d'autre TLD proposé en variante.
    const tlds = ['.com', '.site', '.net', '.online', '.shop'];
    const suffixes = ['', '-pro', '-officiel', 'hq'];
    const candidates: string[] = [];
    for (const tld of tlds) {
      for (const suf of suffixes) {
        const d = `${base}${suf}${tld}`;
        if (d.length <= 63 + tld.length) candidates.push(d);
      }
    }
    // Dédup + limite 8 candidats à tester
    const unique = Array.from(new Set(candidates)).slice(0, 8);

    const variants: { domain: string; available: boolean; priceCredits: number }[] = [];
    for (const domain of unique) {
      if (variants.length >= 5) break;
      let available = false;
      let priceUsd: number | null = null;
      try {
        const result = await checkDomainAvailability(domain);
        available = result.available;
        priceUsd = result.priceUsd;
      } catch {
        // Skip silencieusement si API indisponible pour une variante
        continue;
      }
      // Prix calculé PAR domaine — chaque extension/nom a son propre tarif
      // GoDaddy réel, jamais un prix unique réutilisé pour toutes les variantes.
      const { priceCredits } = resolvePriceCredits(
        user.plan,
        user.domainsUsed ?? 0,
        user.creditsBalance ?? 0,
        priceUsd
      );
      variants.push({ domain, available, priceCredits });
    }

    // Toujours renvoyer au moins les 3 premières candidates même si check a échoué
    if (variants.length === 0) {
      for (const domain of unique.slice(0, 5)) {
        variants.push({ domain, available: false, priceCredits: 0 });
      }
    }

    res.json({ variants: variants.slice(0, 5) });
  } catch (err) {
    next(err);
  }
});
