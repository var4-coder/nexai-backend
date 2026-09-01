import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { checkDomainAvailability } from '@/services/godaddy.service';
import {
  getDomainQuotaInfo,
  CREDIT_COSTS,
} from '@/services/credits.service';

export const domainsRouter = Router();

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
          creditCost: info.canUseIncluded ? 0 : CREDIT_COSTS.DOMAINE_GODADDY,
          description:
            'Nom de domaine personnalisé via notre partenaire. Inclus dans votre abonnement si quota restant, sinon débit de crédits.',
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
  creditsBalance: number
): { priceCredits: number; canAfford: boolean } {
  const info = getDomainQuotaInfo(plan as import('@/models/User').UserPlan, domainsUsed);
  const priceCredits = info.canUseIncluded ? 0 : CREDIT_COSTS.DOMAINE_GODADDY;
  // Règle anti-faillite : si prix > solde → canAfford false (refus au lancer)
  const canAfford = priceCredits === 0 || creditsBalance >= priceCredits;
  return { priceCredits, canAfford };
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
    try {
      available = await checkDomainAvailability(domain);
    } catch {
      throw new AppError(
        'Impossible de vérifier ce domaine pour le moment. Réessayez dans un instant.',
        502
      );
    }

    const { priceCredits, canAfford } = resolvePriceCredits(
      user.plan,
      user.domainsUsed ?? 0,
      user.creditsBalance ?? 0
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

    const { priceCredits } = resolvePriceCredits(
      user.plan,
      user.domainsUsed ?? 0,
      user.creditsBalance ?? 0
    );

    const tlds = ['.com', '.fr', '.net', '.co', '.io'];
    const suffixes = ['', '-pro', '-officiel', '-site', 'hq'];
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
      try {
        available = await checkDomainAvailability(domain);
      } catch {
        // Skip silencieusement si API indisponible pour une variante
        continue;
      }
      variants.push({ domain, available, priceCredits });
    }

    // Toujours renvoyer au moins les 3 premières candidates même si check a échoué
    if (variants.length === 0) {
      for (const domain of unique.slice(0, 5)) {
        variants.push({ domain, available: false, priceCredits });
      }
    }

    res.json({ variants: variants.slice(0, 5) });
  } catch (err) {
    next(err);
  }
});
