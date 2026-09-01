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
