import { Types } from 'mongoose';
import { Domain, IDomain } from '@/models/Domain';
import { User } from '@/models/User';
import {
  getDomainTld,
  getDomainMonthlyRenewalCredits,
  resolveRenewalAnnualUsd,
  debitCredits,
} from '@/services/credits.service';
import { renewDomain, getDomainDetails } from '@/services/godaddy.service';
import {
  sendDomainProvisioningInterruptedEmail,
  sendDomainExpiryReminderEmail,
} from '@/services/brevo.service';

/**
 * Renouvellement des domaines — provisionnement mensuel.
 *
 * Principe
 * --------
 * Le renouvellement automatique GoDaddy est désactivé à l'achat : NexAI ne
 * doit jamais avancer une somme qu'elle n'a pas encaissée. À la place, à
 * partir de la 2ème année, une petite part de crédits est prélevée chaque mois
 * sur le quota du client. Au bout de 12 prélèvements, la provision couvre le
 * renouvellement et celui-ci peut être déclenché.
 *
 * Trois conséquences voulues :
 *  - NexAI encaisse avant de payer, jamais l'inverse.
 *  - La charge est indolore pour le client (quelques crédits/mois fondus dans
 *    un abonnement qu'il paie déjà), au lieu d'une facture annuelle refusée.
 *  - Un client qui arrête son abonnement cesse de provisionner : le domaine
 *    expire, et NexAI ne paie rien pour quelqu'un qui ne paie plus.
 *
 * Le montant mensuel dépend de l'extension : un .com (23 $/an) ne peut pas
 * coûter autant qu'un .online (55 $/an). Voir getDomainMonthlyRenewalCredits.
 */

/** Nombre de prélèvements mensuels qui couvrent une année de renouvellement. */
const MONTHS_PER_CYCLE = 12;

/**
 * Prélèvements échoués tolérés avant de considérer la provision interrompue.
 * On ne coupe jamais sèchement : le client est prévenu et peut recharger.
 */
const MAX_FAILED_CHARGES = 3;

/** Jours restants avant expiration qui déclenchent un rappel au client. */
const REMINDER_DAYS = [60, 30, 7];

/**
 * Fenêtre (en jours avant échéance) dans laquelle on déclenche réellement le
 * renouvellement chez GoDaddy, une fois la provision constituée.
 */
const RENEW_WINDOW_DAYS = 30;

/** Jours entiers restants avant une date. */
function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Enregistre un domaine fraîchement acheté et arme son provisionnement.
 * Appelé après un achat GoDaddy réussi.
 */
export async function registerPurchasedDomain(opts: {
  userId: Types.ObjectId | string;
  siteId?: Types.ObjectId | string;
  domainName: string;
  usedFreeQuota: boolean;
  freeBudgetSpentUsd: number;
  creditsChargedAtPurchase: number;
  /** Prix RÉEL renvoyé par GoDaddy pour ce nom exact, en USD. */
  observedPriceUsd?: number | null;
}): Promise<IDomain> {
  const domainName = opts.domainName.toLowerCase().trim();
  const tld = getDomainTld(domainName);
  const observed = opts.observedPriceUsd ?? null;
  const monthlyRenewalCredits = getDomainMonthlyRenewalCredits(domainName, observed);

  const now = new Date();
  // L'achat couvre 12 mois : le provisionnement et l'expiration se calent
  // tous deux sur cette échéance.
  const oneYearLater = new Date(now);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

  const existing = await Domain.findOne({ domainName });
  if (existing) return existing;

  return Domain.create({
    userId: opts.userId,
    siteId: opts.siteId,
    domainName,
    tld,
    usedFreeQuota: opts.usedFreeQuota,
    freeBudgetSpentUsd: opts.freeBudgetSpentUsd,
    creditsChargedAtPurchase: opts.creditsChargedAtPurchase,
    renewalAnnualUsd: resolveRenewalAnnualUsd(domainName, observed),
    monthlyRenewalCredits,
    creditsProvisioned: 0,
    creditsTarget: monthlyRenewalCredits * MONTHS_PER_CYCLE,
    expiresAt: oneYearLater,
    provisioningStartsAt: oneYearLater,
    status: 'premiere_annee',
  });
}

/** Un mois écoulé depuis le dernier prélèvement (ou depuis le démarrage) ? */
function isChargeDue(domain: IDomain, now: Date): boolean {
  const reference = domain.lastChargeAt ?? domain.provisioningStartsAt;
  const next = new Date(reference);
  next.setMonth(next.getMonth() + 1);
  return now >= next;
}

/**
 * Balayage périodique : prélève les provisions dues et envoie les rappels
 * d'expiration. Conçu pour être rejouable sans effet de bord (idempotent sur
 * un même mois grâce à lastChargeAt).
 */
export async function runDomainRenewalProvisioning(): Promise<{
  scanned: number;
  charged: number;
  interrupted: number;
  readyToRenew: number;
  renewed: number;
  renewFailed: number;
  remindersSent: number;
}> {
  const now = new Date();
  let charged = 0;
  let interrupted = 0;
  let readyToRenew = 0;
  let renewed = 0;
  let renewFailed = 0;
  let remindersSent = 0;

  // Domaines encore vivants dont le provisionnement a démarré.
  const domains: IDomain[] = await Domain.find({
    status: {
      $in: [
        'premiere_annee',
        'provisionnement',
        'provision_interrompue',
        'pret_a_renouveler',
      ],
    },
    provisioningStartsAt: { $lte: now },
  }).limit(500);

  for (const domain of domains) {
    // Passage en phase de provisionnement au 13ème mois.
    if (domain.status === 'premiere_annee') {
      domain.status = 'provisionnement';
    }

    if (isChargeDue(domain, now)) {
      try {
        await debitCredits(domain.userId, domain.monthlyRenewalCredits, 'achat_domaine', {
          note: `renouvellement:${domain.domainName}`,
        });
        domain.creditsProvisioned += domain.monthlyRenewalCredits;
        domain.lastChargeAt = now;
        domain.failedChargeCount = 0;
        if (domain.status === 'provision_interrompue') {
          domain.status = 'provisionnement';
        }
        charged += 1;
      } catch {
        // Solde insuffisant (ou action refusée) : on ne coupe pas, on compte.
        domain.failedChargeCount += 1;
        if (domain.failedChargeCount >= MAX_FAILED_CHARGES) {
          domain.status = 'provision_interrompue';
          interrupted += 1;
          await notifyProvisioningInterrupted(domain);
        }
      }
    }

    if (domain.creditsProvisioned >= domain.creditsTarget) {
      domain.status = 'pret_a_renouveler';
      readyToRenew += 1;
    }

    // Déclenchement effectif du renouvellement chez GoDaddy.
    //
    // Deux conditions cumulées, volontairement strictes : la provision est
    // constituée ET l'échéance approche. Renouveler trop tôt immobiliserait
    // la trésorerie sans bénéfice ; trop tard ferait expirer le domaine.
    if (
      domain.status === 'pret_a_renouveler' &&
      daysUntil(domain.expiresAt, now) <= RENEW_WINDOW_DAYS
    ) {
      try {
        await renewDomain(domain.domainName, 1);

        // On recale l'échéance sur ce que GoDaddy annonce réellement plutôt
        // que de supposer « +1 an » : en cas de décalage, le prochain cycle
        // serait faussé pour toujours.
        let newExpiry: Date | null = null;
        try {
          const details = await getDomainDetails(domain.domainName);
          if (details.expires) newExpiry = new Date(details.expires);
        } catch {
          // Détails indisponibles : on retombe sur +1 an, corrigé au prochain
          // passage si GoDaddy redevient joignable.
        }
        if (!newExpiry || Number.isNaN(newExpiry.getTime())) {
          newExpiry = new Date(domain.expiresAt);
          newExpiry.setFullYear(newExpiry.getFullYear() + 1);
        }

        // Nouveau cycle : la provision consommée est remise à zéro et le
        // reliquat éventuel est reporté (le client ne perd jamais de crédits).
        domain.creditsProvisioned = Math.max(
          0,
          domain.creditsProvisioned - domain.creditsTarget
        );
        domain.expiresAt = newExpiry;
        domain.provisioningStartsAt = now;
        domain.lastChargeAt = now;
        domain.remindersSent = [];
        domain.status = 'provisionnement';
        renewed += 1;
        console.log(`[domaines] Renouvelé ${domain.domainName} -> ${newExpiry.toISOString()}`);
      } catch (e) {
        // Échec GoDaddy : on laisse le statut 'pret_a_renouveler'. Le prochain
        // passage réessaiera, et les rappels d'échéance continuent de partir.
        renewFailed += 1;
        console.error(`[domaines] Renouvellement échoué ${domain.domainName}`, e);
      }
    }

    // Rappels d'expiration.
    const daysLeft = daysUntil(domain.expiresAt, now);
    for (const threshold of REMINDER_DAYS) {
      if (daysLeft <= threshold && !domain.remindersSent.includes(threshold)) {
        await notifyExpiryApproaching(domain, daysLeft);
        domain.remindersSent.push(threshold);
        remindersSent += 1;
        break;
      }
    }

    await domain.save();
  }

  return {
    scanned: domains.length,
    charged,
    interrupted,
    readyToRenew,
    renewed,
    renewFailed,
    remindersSent,
  };
}

async function notifyProvisioningInterrupted(domain: IDomain): Promise<void> {
  const user = await User.findById(domain.userId).select('email prenom');
  if (!user?.email) return;
  await sendDomainProvisioningInterruptedEmail({
    to: user.email,
    prenom: user.prenom,
    domainName: domain.domainName,
    expiresAt: domain.expiresAt,
  }).catch(() => undefined);
}

async function notifyExpiryApproaching(domain: IDomain, daysLeft: number): Promise<void> {
  const user = await User.findById(domain.userId).select('email prenom');
  if (!user?.email) return;
  await sendDomainExpiryReminderEmail({
    to: user.email,
    prenom: user.prenom,
    domainName: domain.domainName,
    daysLeft,
  }).catch(() => undefined);
}
