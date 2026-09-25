import { Site, ISite } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';
import { creditCredits } from '@/services/credits.service';
import {
  SITE_PANNE_BLOQUANTE,
  SITE_RELANCE_GRATUITE_ATTENTE,
  SITE_RELANCE_GRATUITE_PRETE,
  SITE_GENERATION_REMBOURSEE,
} from '@/constants/textes-client';

/** Compte à rebours avant la relance gratuite client, après l'échec de la reprise auto. */
export const FREE_RELAUNCH_DELAY_MS = 30 * 60 * 1000;

export function minutesRestantesRelance(availableAt?: Date | null): number {
  if (!availableAt) return 0;
  return Math.max(0, Math.ceil((availableAt.getTime() - Date.now()) / 60_000));
}

export function relanceGratuiteEstPrete(site: Pick<ISite, 'freeRelaunchAvailable' | 'freeRelaunchUsed' | 'freeRelaunchAvailableAt'>): boolean {
  if (!site.freeRelaunchAvailable || site.freeRelaunchUsed) return false;
  if (!site.freeRelaunchAvailableAt) return true;
  return site.freeRelaunchAvailableAt.getTime() <= Date.now();
}

/**
 * Relance gratuite client : 1 seule, éventuellement après 30 min.
 * Lève une AppError explicite si elle n'est pas encore ouverte.
 */
export function assertRelanceGratuiteAutorisee(site: ISite): void {
  if (site.generationRefunded) {
    throw new AppError(
      'Les crédits de cette commande ont déjà été rendus. Lancez une nouvelle création quand le service sera rétabli.',
      400
    );
  }
  if (site.freeRelaunchUsed) {
    throw new AppError(
      'La relance gratuite a déjà été utilisée pour cette commande.',
      400
    );
  }
  if (!site.freeRelaunchAvailable) {
    throw new AppError('Aucune relance gratuite n’est ouverte sur cette commande.', 400);
  }
  const minutes = minutesRestantesRelance(site.freeRelaunchAvailableAt);
  if (minutes > 0) {
    throw new AppError(
      `La relance gratuite sera disponible dans ${minutes} minute${minutes > 1 ? 's' : ''}. Merci de patienter.`,
      429
    );
  }
}

/** Ouvre la relance gratuite (immédiate si bloquant, +30 min si reprise auto déjà tentée). */
export async function ouvrirRelanceGratuite(
  siteId: string,
  opts: { delayMs: number; clientMessage: string; lastError: string }
): Promise<void> {
  const availableAt = new Date(Date.now() + Math.max(0, opts.delayMs));
  await Site.findByIdAndUpdate(siteId, {
    status: 'failed',
    freeRelaunchAvailable: true,
    freeRelaunchAvailableAt: availableAt,
    clientMessage: opts.clientMessage,
    lastError: opts.lastError.slice(0, 1000),
  });
}

export async function rembourserGenerationEchouee(
  siteId: string,
  userId: string,
  credits: number,
  lastError: string
): Promise<void> {
  if (credits > 0) {
    await creditCredits(userId, credits, 'ajustement_admin', {
      relatedSiteId: siteId,
      note: 'remboursement_generation_site_double_echec',
    });
  }
  await Site.findByIdAndUpdate(siteId, {
    status: 'failed',
    freeRelaunchAvailable: false,
    generationRefunded: true,
    clientMessage: SITE_GENERATION_REMBOURSEE,
    lastError: lastError.slice(0, 1000),
  });
}

export { SITE_PANNE_BLOQUANTE, SITE_RELANCE_GRATUITE_ATTENTE, SITE_RELANCE_GRATUITE_PRETE, SITE_GENERATION_REMBOURSEE };
