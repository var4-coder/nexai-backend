import { Types } from 'mongoose';
import { Site } from '@/models/Site';
import { SiteVisit } from '@/models/SiteVisit';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { debitCredits } from '@/services/credits.service';
import { aUnAbonnementActif, joursDepuisFinAbonnement, type EtatAbonnement } from '@/utils/abonnement';

/**
 * Hébergement gratuit des sites NexAI.
 *
 * Un site est hébergé gratuitement, à vie. Tant que son propriétaire a un
 * abonnement actif, il n'y a AUCUNE limite. Sans abonnement actif, un quota
 * mensuel de visiteurs s'applique, dégressif dans le temps : un site laissé
 * longtemps sans abonnement coûte de moins en moins, ce qui borne
 * durablement la charge d'hébergement.
 *
 * Au-delà du quota, le propriétaire choisit : reprendre son abonnement, ou
 * payer l'hébergement seul. Rien n'est jamais supprimé.
 */

/** Crédits mensuels de l'hébergement seul. */
export const HEBERGEMENT_SEUL_CREDITS_MOIS = 40;

/** Durées d'hébergement seul proposées, en mois. */
export const HEBERGEMENT_SEUL_DUREES = [1, 3, 6] as const;

/**
 * Quota mensuel de visiteurs sans abonnement actif, selon l'ancienneté de la
 * fin d'abonnement.
 */
export function quotaVisiteursMensuel(joursSansAbonnement: number): number {
  if (joursSansAbonnement < 180) return 3000;
  if (joursSansAbonnement < 540) return 2000;
  return 1000;
}

/**
 * Délais de la gradation, en jours depuis le premier dépassement. Le
 * propriétaire est informé à chaque étape, jamais surpris.
 */
const DELAIS = {
  modeLimite: 15,
  dernierAvertissement: 30,
  suspension: 38,
} as const;

/** Premier jour du mois courant, pour le comptage des visiteurs. */
function debutDuMois(maintenant: Date): Date {
  return new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));
}

/**
 * Visiteurs du mois courant : visiteurs distincts par jour, cumulés.
 * Un même visiteur revenant un autre jour compte à nouveau — c'est bien du
 * trafic supplémentaire à héberger.
 */
export async function compterVisiteursDuMois(
  siteId: Types.ObjectId | string,
  maintenant = new Date()
): Promise<number> {
  const resultat = await SiteVisit.aggregate<{ total: number }>([
    {
      $match: {
        siteId: new Types.ObjectId(String(siteId)),
        createdAt: { $gte: debutDuMois(maintenant) },
      },
    },
    { $group: { _id: '$empreinteJour' } },
    { $count: 'total' },
  ]);
  return resultat[0]?.total ?? 0;
}

/**
 * L'hébergement du site est-il couvert, sans condition de quota ?
 * Oui si le propriétaire a un abonnement actif, ou s'il a payé
 * l'hébergement seul pour la période en cours.
 */
function estCouvert(
  proprietaire: EtatAbonnement,
  payeJusquAu: Date | undefined,
  maintenant: Date
): boolean {
  if (aUnAbonnementActif(proprietaire, maintenant)) return true;
  return !!payeJusquAu && new Date(payeJusquAu).getTime() > maintenant.getTime();
}

/**
 * Contrôle quotidien de tous les sites en ligne.
 *
 * Entièrement automatique : aucune intervention de l'administrateur. Chaque
 * étape n'est franchie qu'une fois (champ `etape`), et un site redevient
 * normal dès que son hébergement est de nouveau couvert.
 */
export async function controlerHebergement(maintenant = new Date()): Promise<{
  controles: number;
  depassements: number;
  suspendus: number;
  retablis: number;
}> {
  const sites = await Site.find({ status: { $in: ['launched', 'offline'] } }).select(
    'userId status hebergement'
  );

  let depassements = 0;
  let suspendus = 0;
  let retablis = 0;

  for (const site of sites) {
    const proprietaire = await User.findById(site.userId).select('plan role planExpiresAt');
    if (!proprietaire) continue;

    const heb = site.hebergement ?? {};
    const couvert = estCouvert(proprietaire, heb.payeJusquAu, maintenant);

    // ── Hébergement couvert : tout redevient normal ──
    if (couvert) {
      if (heb.etape && heb.etape !== 'aucune') {
        // Un site suspendu pour dépassement revient en ligne automatiquement
        // dès que l'hébergement est de nouveau couvert.
        if (heb.etape === 'suspendu' && site.status === 'offline') {
          site.status = 'launched';
        }
        site.hebergement = { ...heb, etape: 'aucune', depassementDepuis: undefined };
        await site.save();
        retablis += 1;
      }
      continue;
    }

    // ── Sans couverture : quota dégressif ──
    const visiteurs = await compterVisiteursDuMois(site._id, maintenant);
    const quota = quotaVisiteursMensuel(joursDepuisFinAbonnement(proprietaire, maintenant));
    heb.visiteursMois = visiteurs;

    if (visiteurs <= quota) {
      // Sous le quota ce mois-ci : on efface un éventuel dépassement passé.
      if (heb.depassementDepuis) {
        heb.depassementDepuis = undefined;
        heb.etape = 'aucune';
      }
      site.hebergement = heb;
      await site.save();
      continue;
    }

    depassements += 1;
    if (!heb.depassementDepuis) heb.depassementDepuis = maintenant;
    const jours = Math.floor(
      (maintenant.getTime() - new Date(heb.depassementDepuis).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (jours >= DELAIS.suspension) {
      if (heb.etape !== 'suspendu') {
        site.status = 'offline';
        heb.etape = 'suspendu';
        suspendus += 1;
      }
    } else if (jours >= DELAIS.dernierAvertissement) {
      heb.etape = 'dernier_avertissement';
    } else if (jours >= DELAIS.modeLimite) {
      heb.etape = 'mode_limite';
    } else {
      heb.etape = 'avertissement';
    }

    site.hebergement = heb;
    await site.save();
  }

  return { controles: sites.length, depassements, suspendus, retablis };
}

/**
 * Paiement de l'hébergement seul.
 *
 * Réservé aux comptes sans abonnement actif — un abonné actif a déjà
 * l'hébergement illimité inclus. La durée s'ajoute à une période déjà payée,
 * sans perte de jours. Le site est rétabli immédiatement.
 */
export async function payerHebergementSeul(
  userId: Types.ObjectId | string,
  siteId: Types.ObjectId | string,
  mois: number
): Promise<{ payeJusquAu: Date; creditsDebites: number }> {
  if (!HEBERGEMENT_SEUL_DUREES.includes(mois as (typeof HEBERGEMENT_SEUL_DUREES)[number])) {
    throw new AppError('Durée d’hébergement invalide.', 400);
  }

  const site = await Site.findOne({ _id: siteId, userId });
  if (!site) throw new AppError('Site introuvable.', 404);

  const proprietaire = await User.findById(userId).select('plan role planExpiresAt');
  if (!proprietaire) throw new AppError('Utilisateur introuvable.', 404);
  if (aUnAbonnementActif(proprietaire)) {
    throw new AppError(
      'Votre abonnement inclut déjà l’hébergement de votre site, sans aucune limite de visiteurs.',
      400
    );
  }

  const credits = HEBERGEMENT_SEUL_CREDITS_MOIS * mois;
  await debitCredits(userId, credits, 'hebergement_seul', {
    relatedSiteId: site._id,
    note: `hebergement_seul:${mois}_mois`,
  });

  const maintenant = new Date();
  const heb = site.hebergement ?? {};
  const base =
    heb.payeJusquAu && new Date(heb.payeJusquAu).getTime() > maintenant.getTime()
      ? new Date(heb.payeJusquAu)
      : new Date(maintenant);
  base.setMonth(base.getMonth() + mois);

  heb.payeJusquAu = base;
  heb.etape = 'aucune';
  heb.depassementDepuis = undefined;
  site.hebergement = heb;
  if (site.status === 'offline') site.status = 'launched';
  await site.save();

  return { payeJusquAu: base, creditsDebites: credits };
}
