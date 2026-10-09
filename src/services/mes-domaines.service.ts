import { Types } from 'mongoose';
import { AppError } from '@/middleware/errorHandler';
import { Domain, IDomain } from '@/models/Domain';
import { Site } from '@/models/Site';
import { User } from '@/models/User';
import { redisConnection } from '@/config/redis';
import {
  addNetlifyDnsRecordChez,
  checkDomainAvailability,
  purchaseDomain,
} from '@/services/registrar.service';
import { lireVendeurDomaine } from '@/services/registrar-reglage.service';
import { attachDomain, getNetlifyHost } from '@/services/netlify.service';
import { registerPurchasedDomain } from '@/services/domain-renewal.service';
import {
  isDomainTooExpensive,
  refundLaunchCharges,
  resolveDomainCostAndConsume,
} from '@/services/credits.service';

/**
 * « Mes domaines » — les noms de domaine achetés par le client.
 *
 * Un client peut acheter plusieurs domaines, avec ou sans site. Chaque
 * domaine acheté est enregistré (modèle Domain) et peut ensuite être
 * attribué à l'un de ses sites. Un domaine attribué à un site déjà en
 * ligne est branché immédiatement ; attribué à un site pas encore en
 * ligne, il est prérempli sur la page de mise en ligne et n'est jamais
 * racheté (voir enqueueLaunch → domaine déjà possédé).
 */

const DOMAINE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export interface MonDomaine {
  id: string;
  domaine: string;
  achete: string;
  expire: string;
  statut: IDomain['status'];
  /** Crédits prélevés chaque mois à partir de la 2e année. */
  creditsMensuelsRenouvellement: number;
  site: { id: string; nom: string; statut: string } | null;
}

export async function listerMesDomaines(userId: string): Promise<MonDomaine[]> {
  const domaines = (await Domain.find({ userId, status: { $ne: 'expire' } })
    .sort({ createdAt: -1 })
    .lean()) as unknown as IDomain[];
  const siteIds = domaines.map((d) => d.siteId).filter(Boolean) as Types.ObjectId[];
  const sites = siteIds.length
    ? await Site.find({ _id: { $in: siteIds }, userId }).select('name status niche').lean()
    : [];
  const parId = new Map(sites.map((s) => [String(s._id), s]));
  return domaines.map((d) => {
    const s = d.siteId ? parId.get(String(d.siteId)) : undefined;
    return {
      id: String(d._id),
      domaine: d.domainName,
      achete: (d.createdAt ?? new Date()).toISOString(),
      expire: new Date(d.expiresAt).toISOString(),
      statut: d.status,
      creditsMensuelsRenouvellement: d.monthlyRenewalCredits,
      site: s ? { id: String(s._id), nom: (s as { name?: string }).name || 'Site sans nom', statut: String(s.status) } : null,
    };
  });
}

/** Le domaine appartient-il déjà à ce client ? (achat précédent, avec ou sans site) */
export async function domainePossede(userId: string, domaine: string): Promise<IDomain | null> {
  return (await Domain.findOne({
    userId,
    domainName: domaine.toLowerCase().trim(),
    status: { $ne: 'expire' },
  })) as IDomain | null;
}

/**
 * Achat d'un domaine SANS site : le client le garde dans « Mes domaines »
 * et l'attribue quand il veut. Mêmes règles de prix que l'achat au
 * lancement (quota de l'abonnement, sinon crédits) ; remboursé si l'achat
 * chez le vendeur échoue.
 */
export async function acheterDomaineSeul(userId: string, domaineBrut: string): Promise<MonDomaine> {
  const domaine = domaineBrut.toLowerCase().trim();
  if (!DOMAINE_RE.test(domaine)) throw new AppError('Nom de domaine invalide (ex. monentreprise.com).', 400);

  const user = await User.findById(userId).select('plan role');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  if (user.role !== 'admin' && (user.plan === 'trial' || user.plan === 'starter')) {
    throw new AppError("L'achat d'un nom de domaine est réservé aux abonnés Créateur+, Agence et Pro Max.", 403);
  }
  if (await domainePossede(userId, domaine)) {
    throw new AppError('Ce domaine est déjà dans « Mes domaines ».', 409);
  }

  const verrou = `achat-domaine:${userId}:${domaine}`;
  if (!(await redisConnection.set(verrou, '1', 'EX', 120, 'NX'))) {
    throw new AppError('Achat déjà en cours pour ce domaine. Patientez quelques secondes.', 409);
  }

  try {
    let disponible = false;
    let prixUsd: number | null = null;
    try {
      const r = await checkDomainAvailability(domaine);
      disponible = r.available;
      prixUsd = r.priceUsd;
    } catch {
      throw new AppError('Impossible de vérifier ce domaine pour le moment. Réessayez dans un instant.', 502);
    }
    if (!disponible) {
      throw new AppError(`Le nom de domaine « ${domaine} » n'est pas disponible. Choisissez une variante.`, 409);
    }
    if (prixUsd !== null && isDomainTooExpensive(domaine, prixUsd)) {
      throw new AppError('Ce nom est trop coûteux à maintenir sur la durée. Essayez une variante.', 400);
    }

    // Débit (quota inclus ou crédits) AVANT l'achat ; remboursé si l'achat échoue.
    const charge = await resolveDomainCostAndConsume(userId, 'godaddy', { domainName: domaine, priceUsd: prixUsd });
    const vendeur = await lireVendeurDomaine();
    try {
      await purchaseDomain(domaine, 1);
    } catch (err) {
      await refundLaunchCharges(
        userId,
        {
          launchCredits: 0,
          domainCredits: charge.chargedCredits,
          usedDomainQuota: charge.usedQuota,
          domainBudgetSpentUsd: charge.budgetSpentUsd,
        },
        { reason: 'remboursement_achat_domaine_echoue' }
      ).catch((e) => console.error(`[mes-domaines] ALERTE remboursement impossible user=${userId}`, e));
      console.error('[mes-domaines] Achat chez le vendeur échoué', err);
      throw new AppError("L'achat du domaine n'a pas pu aboutir. Vous n'avez pas été débité. Réessayez dans un instant.", 502);
    }

    await registerPurchasedDomain({
      userId,
      domainName: domaine,
      usedFreeQuota: charge.usedQuota,
      freeBudgetSpentUsd: charge.budgetSpentUsd,
      creditsChargedAtPurchase: charge.chargedCredits,
      observedPriceUsd: prixUsd,
      registrar: vendeur,
    });
    const liste = await listerMesDomaines(userId);
    return liste.find((d) => d.domaine === domaine)!;
  } finally {
    await redisConnection.del(verrou).catch(() => undefined);
  }
}

/**
 * Branche un domaine possédé sur un site DÉJÀ en ligne : DNS chez le
 * vendeur réel + domaine personnalisé chez l'hébergeur (le sous-domaine
 * NexAI reste en alias, le site ne devient jamais injoignable).
 */
async function brancherSurSiteEnLigne(domaine: IDomain, netlifySiteId: string, slug?: string): Promise<void> {
  const hote = await getNetlifyHost(netlifySiteId);
  try {
    await addNetlifyDnsRecordChez(domaine.registrar ?? 'godaddy', domaine.domainName, hote);
  } catch (err) {
    console.warn('[mes-domaines] DNS non posé (non bloquant)', err);
  }
  await attachDomain(netlifySiteId, domaine.domainName, slug);
}

export async function attribuerDomaine(
  userId: string,
  domaineId: string,
  siteId: string
): Promise<{ domaine: MonDomaine; enLigne: boolean; message: string }> {
  if (!Types.ObjectId.isValid(domaineId) || !Types.ObjectId.isValid(siteId)) {
    throw new AppError('Domaine ou site introuvable.', 404);
  }
  const domaine = (await Domain.findOne({ _id: domaineId, userId })) as IDomain | null;
  if (!domaine) throw new AppError('Domaine introuvable.', 404);
  if (domaine.status === 'expire') throw new AppError('Ce domaine a expiré.', 400);
  const site = await Site.findOne({ _id: siteId, userId });
  if (!site) throw new AppError('Site introuvable.', 404);

  // Un domaine ne sert qu'un site à la fois : l'ancien site retrouve son adresse NexAI.
  if (domaine.siteId && String(domaine.siteId) !== siteId) {
    const ancien = await Site.findOne({ _id: domaine.siteId, userId });
    if (ancien && ancien.domainName === domaine.domainName) {
      if (ancien.netlifySiteId && !String(ancien.netlifySiteId).startsWith('local_') && ancien.subdomainSlug) {
        const { revertToSubdomain } = await import('@/services/netlify.service');
        await revertToSubdomain(ancien.netlifySiteId, ancien.subdomainSlug).catch((e) =>
          console.warn('[mes-domaines] retour au sous-domaine de l’ancien site échoué', e)
        );
      }
      ancien.domainType = 'sous_domaine';
      ancien.domainName = ancien.subdomainSlug
        ? `${ancien.subdomainSlug}.${(await import('@/config/env')).env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`
        : undefined;
      await ancien.save();
    }
  }

  const enLigne = site.status === 'launched' || site.status === 'offline';
  if (enLigne && site.netlifySiteId && !String(site.netlifySiteId).startsWith('local_')) {
    await brancherSurSiteEnLigne(domaine, site.netlifySiteId, site.subdomainSlug);
  }
  site.domainType = 'godaddy';
  site.domainName = domaine.domainName;
  await site.save();
  domaine.siteId = site._id;
  await (domaine as unknown as { save: () => Promise<unknown> }).save();

  const liste = await listerMesDomaines(userId);
  return {
    domaine: liste.find((d) => d.id === domaineId)!,
    enLigne,
    message: enLigne
      ? `${domaine.domainName} est maintenant l'adresse de votre site. La mise en service prend de quelques minutes à 24 h.`
      : `${domaine.domainName} est attribué à ce site. Il sera utilisé automatiquement à la mise en ligne, sans frais supplémentaires.`,
  };
}

/** Retire l'attribution (site pas encore en ligne uniquement). */
export async function retirerAttribution(userId: string, domaineId: string): Promise<MonDomaine> {
  if (!Types.ObjectId.isValid(domaineId)) throw new AppError('Domaine introuvable.', 404);
  const domaine = (await Domain.findOne({ _id: domaineId, userId })) as IDomain | null;
  if (!domaine) throw new AppError('Domaine introuvable.', 404);
  if (domaine.siteId) {
    const site = await Site.findOne({ _id: domaine.siteId, userId });
    if (site && (site.status === 'launched' || site.status === 'offline') && site.domainName === domaine.domainName) {
      throw new AppError(
        "Ce domaine sert d'adresse à un site en ligne. Attribuez-le à un autre site pour le déplacer.",
        400
      );
    }
    if (site && site.domainName === domaine.domainName) {
      site.domainType = undefined;
      site.domainName = undefined;
      await site.save();
    }
  }
  await Domain.updateOne({ _id: domaine._id }, { $unset: { siteId: '' } });
  const liste = await listerMesDomaines(userId);
  return liste.find((d) => d.id === domaineId)!;
}
