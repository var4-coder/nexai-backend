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
  resolveDomainCharge,
  isDomainTooExpensive,
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
    const user = await User.findById(req.auth!.userId).select(
      'plan domainsUsed domainFreeBudgetUsedUsd creditsBalance'
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const info = getDomainQuotaInfo(
      user.plan,
      user.domainsUsed ?? 0,
      user.domainFreeBudgetUsedUsd ?? 0
    );
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
            'Nom de domaine personnalisé via notre partenaire. Selon le nom choisi, il est inclus dans votre abonnement ou nécessite un complément en crédits, affiché avant toute validation.',
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

/**
 * Coût affichable d'un domaine pour ce client.
 *
 * `coverage` dit au frontend quel message montrer :
 *   'included'   -> « Inclus dans votre abonnement »
 *   'complement' -> « Votre abonnement en couvre une partie, il reste X crédits »
 *   'full'       -> prix normal en crédits
 *
 * Le budget interne (DOMAIN_FREE_BUDGET_USD) n'est JAMAIS renvoyé : le client
 * ne voit qu'un nombre de crédits.
 *
 * Si GoDaddy n'a pas renvoyé de prix exploitable, on refuse explicitement
 * plutôt que d'inventer un prix.
 */
function resolvePriceCredits(
  plan: string,
  domainsUsed: number,
  domainFreeBudgetUsedUsd: number,
  creditsBalance: number,
  domain: string,
  priceUsd: number | null
): {
  priceCredits: number;
  canAfford: boolean;
  coverage: 'included' | 'complement' | 'full' | 'unknown';
  monthlyRenewalCredits: number | null;
} {
  if (priceUsd === null) {
    return {
      priceCredits: 0,
      canAfford: false,
      coverage: 'unknown',
      monthlyRenewalCredits: null,
    };
  }

  const charge = resolveDomainCharge(
    plan as import('@/models/User').UserPlan,
    domainsUsed,
    domainFreeBudgetUsedUsd,
    domain,
    priceUsd
  );

  return {
    priceCredits: charge.credits,
    canAfford: charge.credits === 0 || creditsBalance >= charge.credits,
    coverage: charge.kind,
    monthlyRenewalCredits: charge.monthlyRenewalCredits,
  };
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

    const user = await User.findById(req.auth!.userId).select(
      'plan domainsUsed domainFreeBudgetUsedUsd creditsBalance role'
    );
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

    const { priceCredits, canAfford, coverage, monthlyRenewalCredits } = resolvePriceCredits(
      user.plan,
      user.domainsUsed ?? 0,
      user.domainFreeBudgetUsedUsd ?? 0,
      user.creditsBalance ?? 0,
      domain,
      priceUsd
    );

    // Anti-faillite informatif (pas de débit ici)
    if (available && !canAfford && user.role !== 'admin') {
      // On renvoie quand même available + priceCredits ; le frontend peut bloquer
      // Le lancer refusera explicitement si solde insuffisant
    }

    // Un domaine au-dessus du plafond de renouvellement est présenté comme
    // non retenable : inutile de le proposer puis de le refuser à l'achat.
    const tropCher = priceUsd !== null && isDomainTooExpensive(domain, priceUsd);

    res.json({
      domain,
      available: available && !tropCher,
      priceCredits,
      coverage,
      monthlyRenewalCredits,
      ...(tropCher
        ? {
            unavailableReason:
              'Ce nom est trop coûteux à maintenir sur la durée. Essayez une variante.',
          }
        : {}),
    });
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
        /**
         * true : ne proposer que des noms ENTIÈREMENT couverts par
         * l'abonnement (aucun complément en crédits). Utilisé par le bouton
         * « Voir des noms inclus dans mon abonnement ».
         */
        inclusOnly: z.boolean().optional().default(false),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId).select(
      'plan domainsUsed domainFreeBudgetUsedUsd creditsBalance role'
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.role !== 'admin' && (user.plan === 'trial' || user.plan === 'starter')) {
      throw new AppError(
        'Les variantes de domaine sont réservées aux abonnés pouvant créer un site.',
        403
      );
    }

    const inclusOnly = body.inclusOnly;
    const base = body.base;
    if (base.length < 2) {
      throw new AppError('Base de domaine trop courte après normalisation.', 400);
    }

    // 5 extensions officielles NexAI (Architecture v6, section 11) — jamais
    // d'autre TLD proposé en variante.
    // .com et .net en tête : ce sont les seules extensions éligibles à
    // l'offre gratuite (voir FREE_DOMAIN_TLDS), donc celles qui ont le plus
    // de chances d'être entièrement incluses dans l'abonnement.
    const tlds = inclusOnly
      ? ['.com', '.net']
      : ['.com', '.net', '.site', '.online', '.shop'];
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

    const variants: {
      domain: string;
      available: boolean;
      priceCredits: number;
      coverage: 'included' | 'complement' | 'full' | 'unknown';
      monthlyRenewalCredits: number | null;
    }[] = [];
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
      const { priceCredits, coverage, monthlyRenewalCredits } = resolvePriceCredits(
        user.plan,
        user.domainsUsed ?? 0,
        user.domainFreeBudgetUsedUsd ?? 0,
        user.creditsBalance ?? 0,
        domain,
        priceUsd
      );
      // Mode « noms entièrement inclus » : on n'affiche que ce que
      // l'abonnement couvre à 100%, pour offrir au client une porte de sortie
      // sans complément à payer.
      if (inclusOnly && coverage !== 'included') continue;
      // Jamais proposer en variante un nom qu'on refusera ensuite à l'achat.
      if (priceUsd !== null && isDomainTooExpensive(domain, priceUsd)) continue;
      variants.push({ domain, available, priceCredits, coverage, monthlyRenewalCredits });
    }

    // Toujours renvoyer au moins les 3 premières candidates même si check a échoué
    if (variants.length === 0) {
      for (const domain of unique.slice(0, 5)) {
        variants.push({
          domain,
          available: false,
          priceCredits: 0,
          coverage: 'unknown',
          monthlyRenewalCredits: null,
        });
      }
    }

    res.json({ variants: variants.slice(0, 5) });
  } catch (err) {
    next(err);
  }
});
