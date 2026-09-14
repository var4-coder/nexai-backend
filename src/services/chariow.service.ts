import crypto from 'crypto';
import { env } from '@/config/env';
import { PaiementChariow } from '@/models/PaiementChariow';
import { Site } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';

/**
 * Webhook Chariow signé + enregistrement dans paiements_chariow_nexai.
 * Flux : Compte NexAI (Chariow) → webhook → table → délai 3 jours → admin reverse mobile money.
 * Architecture §7.6 + Partie D.9 à D.11.
 */

export function verifyChariowSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!env.CHARIOW_WEBHOOK_SECRET) {
    // En dev sans secret on accepte (log warning)
    if (env.NODE_ENV !== 'production') {
      console.warn('[chariow] CHARIOW_WEBHOOK_SECRET absent — signature non vérifiée (dev only)');
      return true;
    }
    return false;
  }
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', env.CHARIOW_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

export interface ChariowWebhookPayload {
  reference: string;
  montant: number;
  statut: string;
  site_id?: string;
  metadata?: Record<string, unknown>;
}

export class ChariowService {
  /**
   * Crée un lien de paiement dynamique sur Chariow pour l'achat de crédits (10 à 200)
   */
  public static async createPaymentLink(params: {
    amount: number;
    currency: string;
    description: string;
    customerEmail: string;
    metadata: {
      transactionId: string;
      userId: string;
      type: string;
      quantity?: string;
      [key: string]: string | undefined;
    };
  }) {
    try {
      const res = await fetch('https://api.chariow.com/v1/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CHARIOW_API_KEY || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: params.amount,
          currency: params.currency,
          description: params.description,
          customer_email: params.customerEmail,
          metadata: params.metadata,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { payment_link?: string; url?: string };
      if (!res.ok) {
        console.error('Erreur Chariow:', data);
        throw new AppError('Impossible de générer le lien de paiement Chariow.', 502);
      }
      return data.payment_link || data.url;
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      console.error('Erreur lors de la création du lien Chariow:', error);
      throw new AppError('Impossible de générer le lien de paiement Chariow.', 502);
    }
  }
}

/**
 * Traite un webhook Chariow valide.
 * Commission totale NexAI (15% Chariow + 10% marge NexAI = 25%).
 */
export async function handleChariowWebhook(payload: ChariowWebhookPayload) {
  const meta = payload.metadata || {};
  const metaType = String(meta.type || '');

  // ─────────────────────────────────────────────────────────────
  // GARDE-FOU ARGENT : ne jamais créditer sur autre chose qu'un
  // paiement réellement abouti. Chariow envoie aussi des événements
  // 'pending', 'failed', 'refunded' — tous correctement signés, donc
  // la seule signature ne suffit pas à autoriser un crédit.
  // ─────────────────────────────────────────────────────────────
  const statutBrut = String(payload.statut || '').toLowerCase();
  const STATUTS_ABOUTIS = ['success', 'succeeded', 'paid', 'paye', 'payé', 'completed'];
  if (!STATUTS_ABOUTIS.includes(statutBrut)) {
    console.warn(
      `[chariow] Webhook ignoré — statut « ${payload.statut} » (réf. ${payload.reference}). Aucun crédit accordé.`
    );
    return null;
  }

  // Achat de crédits plateforme (pas lié à un site client)
  if (metaType === 'credit_purchase') {
    const transactionId = String(meta.transactionId || '');
    const quantity = meta.quantity ? parseInt(String(meta.quantity), 10) : undefined;
    if (transactionId) {
      const { CreditsService } = await import('@/services/credits.service');
      await CreditsService.fulfillCreditPurchase(transactionId, quantity);
    }
    // Enregistrement minimal sans siteId — on réutilise reference pour l'idempotence via note
    return {
      _id: transactionId || payload.reference,
      type: 'credit_purchase',
      referenceChariow: payload.reference,
    } as unknown as InstanceType<typeof PaiementChariow>;
  }

  // Achat d'ABONNEMENT (Architecture v6, section 7) — le plan n'est JAMAIS
  // appliqué au clic sur "Passer à...", uniquement ici, à la confirmation
  // réelle du paiement par Chariow.
  if (metaType === 'plan_purchase') {
    const userId = String(meta.userId || '');
    const plan = String(meta.plan || '') as 'starter' | 'createur' | 'agence' | 'pro_max';
    if (!userId || !plan) {
      throw new AppError('userId ou plan manquant dans le webhook plan_purchase', 400);
    }

    const { User } = await import('@/models/User');
    const { PLAN_CREDITS } = await import('@/services/credits.service');
    const { CreditTransaction } = await import('@/models/CreditTransaction');

    // IDEMPOTENCE : Chariow peut rejouer un webhook (retry réseau, incident
    // de leur côté). Sans cette garde, chaque rejeu re-créditerait le plan.
    // La référence de paiement est unique par transaction réelle.
    const dejaTraite = await CreditTransaction.findOne({
      type: 'achat_abonnement',
      referencePaiement: payload.reference,
    });
    if (dejaTraite) {
      console.log(`[chariow] Abonnement déjà traité pour la réf. ${payload.reference} — rejeu ignoré.`);
      return {
        _id: userId,
        type: 'plan_purchase',
        referenceChariow: payload.reference,
      } as unknown as InstanceType<typeof PaiementChariow>;
    }

    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur introuvable pour ce paiement', 404);

    const wasTrial = user.plan === 'trial';
    user.plan = plan;
    // Crédits du plan ajoutés au solde existant (jamais de remise à zéro :
    // le client ne doit pas perdre ce qu'il n'a pas encore consommé).
    user.creditsBalance = (user.creditsBalance ?? 0) + (PLAN_CREDITS[plan] ?? 0);
    // L'abonnement payant met fin à l'essai : la date d'expiration n'a plus
    // lieu d'être (sinon le compte resterait marqué comme essai expiré).
    user.trialEndsAt = undefined;
    await user.save();

    // Trace du paiement — sert d'historique, de garde d'idempotence, ET de
    // source pour le reçu téléchargeable (Agence/Pro Max, section 17).
    const montantFcfa = Number(meta.montantFcfa ?? payload.montant ?? 0);
    await CreditTransaction.create({
      userId: user._id,
      type: 'achat_abonnement',
      amount: PLAN_CREDITS[plan] ?? 0,
      balanceAfter: user.creditsBalance,
      montantFcfa,
      referencePaiement: payload.reference,
      note: `Abonnement ${plan}`,
    });

    // Parrainage : récompense versée au parrain UNIQUEMENT ici, à la
    // première conversion payante du filleul (jamais à l'inscription).
    // N'échoue jamais le paiement en cas de problème (voir le service).
    const { grantReferralRewardOnFirstPayment } = await import('@/services/referral.service');
    await grantReferralRewardOnFirstPayment(user._id);

    console.log(
      `[chariow] Abonnement ${plan} activé pour ${user.email}${wasTrial ? ' (conversion depuis essai)' : ''}`
    );

    return {
      _id: userId,
      type: 'plan_purchase',
      referenceChariow: payload.reference,
    } as unknown as InstanceType<typeof PaiementChariow>;
  }

  const existing = await PaiementChariow.findOne({ referenceChariow: payload.reference });
  if (existing) {
    return existing;
  }

  if (!payload.site_id) {
    throw new AppError('site_id manquant dans le webhook Chariow', 400);
  }

  const site = await Site.findById(payload.site_id);
  if (!site) throw new AppError('Site introuvable pour ce paiement', 404);

  const totalCommissionRate = 0.25;
  const commissionNexai = Math.round(payload.montant * totalCommissionRate);

  const paiement = await PaiementChariow.create({
    siteId: site._id,
    referenceChariow: payload.reference,
    montant: payload.montant,
    statut: 'en_attente',
    commissionNexai,
    webhookReceivedAt: new Date(),
  });

  // Méthode de retrait — mode "Compte NexAI" (Architecture v6, section 12) :
  // NexAI a encaissé pour le compte du client, on inscrit la part qui lui
  // revient (montant net de commission) au ledger de reversement. En mode
  // 'lien_personnel', rien à enregistrer : l'argent n'est jamais passé par
  // NexAI.
  if (site.paymentMode === 'chariow' && site.userId) {
    try {
      const { enregistrerEncaissement } = await import('@/services/reversement.service');
      await enregistrerEncaissement({
        userId: site.userId,
        siteId: site._id,
        amountFcfa: payload.montant - commissionNexai,
        reference: payload.reference,
        note: 'Vente encaissée via Compte NexAI',
      });
    } catch (err) {
      // Non bloquant : le paiement reste enregistré même si le ledger
      // échoue, l'écriture manquante pourra être rattrapée côté admin.
      console.error('[chariow] Échec enregistrement ledger reversement :', err);
    }
  }

  return paiement;
}

/**
 * Admin marque un paiement comme payé (reversement mobile money effectué).
 */
export async function markPaiementPaye(paiementId: string) {
  const p = await PaiementChariow.findById(paiementId);
  if (!p) throw new AppError('Paiement introuvable', 404);
  if (p.statut === 'paye') return p;
  p.statut = 'paye';
  p.payeAt = new Date();
  await p.save();
  return p;
}
