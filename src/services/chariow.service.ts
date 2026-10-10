import { VIDEO_AD_ALLOWED_PLANS } from '@/services/credits.service';
import { prolongerAbonnement } from '@/utils/abonnement';
import crypto from 'crypto';
import { env } from '@/config/env';
import { PaiementChariow } from '@/models/PaiementChariow';
import { Site } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';

/**
 * Part prélevée par NexAI sur une vente encaissée via le Compte NexAI.
 *
 * Elle couvre les frais du prestataire de paiement, la mise à disposition du
 * moyen d'encaissement et le reversement au commerçant. Le taux est annoncé
 * au client AVANT qu'il ne choisisse ce mode (voir MSG_COMMISSION_NEXAI) :
 * découvrir un prélèvement après la première vente serait déloyal.
 *
 * Ne s'applique JAMAIS au lien de paiement personnel du client : dans ce
 * cas l'argent ne transite pas par NexAI, et rien n'est prélevé.
 */
export const COMMISSION_NEXAI_TAUX = 0.25;

const CHARIOW_API = 'https://api.chariow.com/v1';

export function verifyChariowSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!env.CHARIOW_WEBHOOK_SECRET) {
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

export function normalizeChariowWebhookBody(body: Record<string, unknown>): ChariowWebhookPayload {
  const sale = (body.sale && typeof body.sale === 'object' ? body.sale : null) as Record<string, unknown> | null;
  const amountObj = sale?.amount as { value?: number } | undefined;
  const metaFromSale =
    (sale?.custom_metadata as Record<string, unknown> | undefined) ||
    (body.custom_metadata as Record<string, unknown> | undefined) ||
    (body.metadata as Record<string, unknown> | undefined) ||
    {};

  if (sale || body.event === 'successful.sale') {
    const status =
      String(sale?.status || '') ||
      (body.event === 'successful.sale' ? 'completed' : '');
    return {
      reference: String(sale?.id || body.id || ''),
      montant: Number(amountObj?.value ?? body.montant ?? body.amount ?? 0),
      statut: status,
      site_id: String(metaFromSale.site_id || body.site_id || '') || undefined,
      metadata: metaFromSale,
    };
  }

  return {
    reference: String(body.reference || body.id || ''),
    montant: Number(body.montant || body.amount || 0),
    statut: String(body.statut || body.status || ''),
    site_id: (body.site_id as string) || (metaFromSale.site_id as string | undefined),
    metadata: (body.metadata as Record<string, unknown>) || metaFromSale,
  };
}

type ListedProduct = {
  id: string;
  name?: string;
  slug?: string;
  pricing?: {
    current_price?: { value?: number; currency?: string };
    price?: { value?: number; currency?: string };
  };
};

let productsCache: { at: number; items: ListedProduct[] } | null = null;

async function chariowFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  if (!env.CHARIOW_API_KEY) {
    // Le détail technique reste dans les logs : le client ne voit jamais le
    // nom du prestataire ni l'hébergement.
    console.error('[chariow] CHARIOW_API_KEY manquant : ajoutez-le dans les variables d’environnement.');
    throw new AppError('Le paiement est momentanément indisponible.', 503);
  }
  const res = await fetch(`${CHARIOW_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CHARIOW_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function listChariowProducts(): Promise<ListedProduct[]> {
  if (productsCache && Date.now() - productsCache.at < 5 * 60 * 1000) return productsCache.items;
  try {
    const { ok, data } = await chariowFetch('/products?per_page=100');
    if (!ok) {
      console.error('[chariow] list products', data);
      return [];
    }
    const items: ListedProduct[] = data?.data?.data || data?.data || data?.products || [];
    productsCache = { at: Date.now(), items: Array.isArray(items) ? items : [] };
    return productsCache.items;
  } catch (err) {
    console.error('[chariow] list products failed', err);
    return [];
  }
}

function productPrice(p: ListedProduct): number | null {
  const v = p.pricing?.current_price?.value ?? p.pricing?.price?.value;
  return typeof v === 'number' ? v : null;
}

const PRODUCT_ENV: Record<string, string> = {
  starter: env.CHARIOW_PRODUCT_STARTER,
  createur: env.CHARIOW_PRODUCT_CREATEUR,
  agence: env.CHARIOW_PRODUCT_AGENCE,
  pro_max: env.CHARIOW_PRODUCT_PRO_MAX,
  pack_10: env.CHARIOW_PRODUCT_PACK_10,
  pack_20: env.CHARIOW_PRODUCT_PACK_20,
  pack_50: env.CHARIOW_PRODUCT_PACK_50,
  pack_100: env.CHARIOW_PRODUCT_PACK_100,
  pack_200: env.CHARIOW_PRODUCT_PACK_200,
};

const PRODUCT_NAMES: Record<string, string[]> = {
  starter: ['starter', 'académie', 'academie'],
  createur: ['créateur+', 'createur+', 'créateur', 'createur'],
  agence: ['agence'],
  pro_max: ['pro max', 'promax', 'pro-max'],
  pack_10: ['pack 10', '10 crédits', '10 credits'],
  pack_20: ['pack 20', '20 crédits', '20 credits'],
  pack_50: ['pack 50', '50 crédits', '50 credits'],
  pack_100: ['pack 100', '100 crédits', '100 credits'],
  pack_200: ['pack 200', '200 crédits', '200 credits'],
};

const PRODUCT_PRICES: Record<string, number> = {
  starter: 5000,
  createur: 10000,
  agence: 25000,
  pro_max: 35000,
  pack_10: 1500,
  pack_20: 3000,
  pack_50: 7500,
  pack_100: 15000,
  pack_200: 30000,
};

function inferProductKey(
  metadata: { type?: string; plan?: string; quantity?: string; [k: string]: string | undefined },
  amount: number
): string {
  const plan = String(metadata.plan || '').toLowerCase();
  if (plan && PRODUCT_ENV[plan] !== undefined) return plan;
  const q = parseInt(String(metadata.quantity || ''), 10);
  if (q && PRODUCT_ENV[`pack_${q}`] !== undefined) return `pack_${q}`;
  const byPrice = Object.entries(PRODUCT_PRICES).find(([, p]) => Math.abs(p - amount) < 1);
  if (byPrice) return byPrice[0];
  return 'starter';
}

async function resolveProductId(productKey: string, fallbackAmount?: number): Promise<string> {
  const fromEnv = (PRODUCT_ENV[productKey] || '').trim();
  if (fromEnv) return fromEnv;

  const products = await listChariowProducts();
  const names = PRODUCT_NAMES[productKey] || [];
  const byName = products.find((p) => {
    const hay = `${p.name || ''} ${p.slug || ''}`.toLowerCase();
    return names.some((want) => hay.includes(want));
  });
  if (byName?.id) return byName.id;

  const target = PRODUCT_PRICES[productKey] ?? fallbackAmount;
  if (target != null) {
    const byPrice = products.find((p) => {
      const pr = productPrice(p);
      return pr != null && Math.abs(pr - target) < 1;
    });
    if (byPrice?.id) return byPrice.id;
  }

  throw new AppError(
    `Produit Chariow introuvable pour « ${productKey} ». Créez-le dans votre boutique Chariow (même nom et même prix) puis renseignez CHARIOW_PRODUCT_${productKey.toUpperCase()} dans Render.`,
    502
  );
}

function splitName(email: string, first?: string, last?: string) {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 50);
  if (first && last) return { first_name: clean(first), last_name: clean(last) };
  if (first && first.trim().includes(' ')) {
    const [a, ...rest] = first.trim().split(/\s+/);
    return { first_name: clean(a), last_name: clean(rest.join(' ') || 'NexAI') };
  }
  const local = (email.split('@')[0] || 'client').replace(/[._-]+/g, ' ').trim() || 'Client';
  return {
    first_name: clean(first || local),
    last_name: clean(last || 'NexAI'),
  };
}

export class ChariowService {
  public static async createPaymentLink(params: {
    amount: number;
    currency: string;
    description: string;
    customerEmail: string;
    customerFirstName?: string;
    customerLastName?: string;
    customerPhone?: string;
    customerPhoneCountry?: string;
    productKey?: string;
    metadata: {
      transactionId: string;
      userId: string;
      type: string;
      quantity?: string;
      [key: string]: string | undefined;
    };
  }) {
    const productKey =
      params.productKey ||
      inferProductKey(params.metadata, params.amount);
    const productId = await resolveProductId(productKey, params.amount);

    let phone = String(params.customerPhone || '').replace(/\D/g, '');
    let firstName = params.customerFirstName;
    let lastName = params.customerLastName;
    if (phone.length < 8 && params.metadata?.userId) {
      const { User } = await import('@/models/User');
      const u = await User.findById(params.metadata.userId).select(
        'prenom nom telephone telephonePays'
      );
      if (u) {
        phone = phone || String(u.telephone || '').replace(/\D/g, '');
        firstName = firstName || u.prenom;
        lastName = lastName || u.nom;
        if (!params.customerPhoneCountry && u.telephonePays) {
          params.customerPhoneCountry = String(u.telephonePays);
        }
      }
    }
    const { first_name, last_name } = splitName(
      params.customerEmail,
      firstName,
      lastName
    );
    if (phone.length < 8) {
      throw new AppError(
        'Indiquez un numéro de téléphone (Mobile Money) pour ouvrir le paiement.',
        400
      );
    }

    const custom_metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(params.metadata)) {
      if (v == null || v === '') continue;
      custom_metadata[k] = String(v).slice(0, 255);
      if (Object.keys(custom_metadata).length >= 10) break;
    }

    const payload = {
      product_id: productId,
      email: params.customerEmail,
      first_name,
      last_name,
      phone: {
        number: phone,
        country_code: (params.customerPhoneCountry || 'CI').toUpperCase().slice(0, 2),
      },
      payment_currency: params.currency === 'USD' ? 'USD' : 'XOF',
      redirect_url: `${env.CLIENT_URL.replace(/\/$/, '')}/abonnement?paiement=ok`,
      custom_metadata,
    };

    const { ok, status, data } = await chariowFetch('/checkout', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!ok) {
      const detail =
        (typeof data?.message === 'string' && data.message) ||
        (Array.isArray(data?.errors) && data.errors[0] && JSON.stringify(data.errors[0])) ||
        JSON.stringify(data).slice(0, 220);
      console.error('[chariow] checkout', status, detail);
      // Le client voit un message de service (code 502) ; l'administrateur
      // voit la raison exacte donnée par Chariow pour pouvoir corriger.
      throw new AppError(
        `Impossible de générer le lien de paiement pour le moment (Chariow ${status} : ${detail}). Réessayez dans un instant.`,
        502
      );
    }

    const nested = data?.data || data;
    const url =
      nested?.payment?.checkout_url ||
      nested?.checkout_url ||
      nested?.url ||
      nested?.payment_link ||
      data?.payment_link;
    if (!url || typeof url !== 'string') {
      console.error('[chariow] checkout sans URL', data);
      throw new AppError(
        'Chariow n’a pas renvoyé d’URL de paiement. Vérifiez que le produit est publié dans votre boutique.',
        502
      );
    }
    return url;
  }
}

export async function handleChariowWebhook(payload: ChariowWebhookPayload) {
  const meta = payload.metadata || {};
  const metaType = String(meta.type || '');

  const statutBrut = String(payload.statut || '').toLowerCase();
  const STATUTS_ABOUTIS = ['success', 'succeeded', 'paid', 'paye', 'payé', 'completed'];
  if (!STATUTS_ABOUTIS.includes(statutBrut)) {
    console.warn(
      `[chariow] Webhook ignoré — statut « ${payload.statut} » (réf. ${payload.reference}). Aucun crédit accordé.`
    );
    return null;
  }

  if (metaType === 'credit_purchase') {
    const transactionId = String(meta.transactionId || '');
    if (transactionId) {
      const { CreditsService } = await import('@/services/credits.service');
      await CreditsService.fulfillCreditPurchase(transactionId);
    }
    return {
      _id: transactionId || payload.reference,
      type: 'credit_purchase',
      referenceChariow: payload.reference,
    } as unknown as InstanceType<typeof PaiementChariow>;
  }

  if (metaType === 'plan_purchase') {
    const userId = String(meta.userId || '');
    const plan = String(meta.plan || '') as 'starter' | 'createur' | 'agence' | 'pro_max';
    if (!userId || !plan) {
      throw new AppError('userId ou plan manquant dans le webhook plan_purchase', 400);
    }

    const { User } = await import('@/models/User');
    const { PLAN_CREDITS } = await import('@/services/credits.service');
    const { CreditTransaction } = await import('@/models/CreditTransaction');

    const reponseRejeu = {
      _id: userId,
      type: 'plan_purchase',
      referenceChariow: payload.reference,
    } as unknown as InstanceType<typeof PaiementChariow>;

    const user = await User.findById(userId);
    if (!user) throw new AppError('Utilisateur introuvable pour ce paiement', 404);

    // ── Idempotence ATOMIQUE ──
    //
    // Chariow peut renvoyer le même webhook plusieurs fois, parfois en même
    // temps. Un « chercher puis créer » laissait passer deux livraisons
    // simultanées : double crédit d'abonnement et double prime de parrainage.
    // On pose donc d'abord la ligne de transaction : l'index unique
    // (type + référence) fait échouer la seconde livraison. Le solde n'est
    // touché qu'après cette réservation.
    const creditsPlan = PLAN_CREDITS[plan] ?? 0;
    const montantFcfa = Number(meta.montantFcfa ?? payload.montant ?? 0);
    let reservation;
    try {
      reservation = await CreditTransaction.create({
        userId: user._id,
        type: 'achat_abonnement',
        amount: creditsPlan,
        balanceAfter: user.creditsBalance ?? 0,
        montantFcfa,
        referencePaiement: payload.reference,
        cleIdempotence: `abo:${payload.reference}`,
        note: `Abonnement ${plan}`,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        console.log(`[chariow] Abonnement déjà traité pour la réf. ${payload.reference} — rejeu ignoré.`);
        return reponseRejeu;
      }
      throw err;
    }

    const wasTrial = user.plan === 'trial';
    try {
      // Bonus Pro Max : la première Pub Présentateur IA de 30 s
      // est offerte à la première souscription Pro Max uniquement. Les autres
      // abonnements n'ont pas de vidéo offerte. L'attribution est
      // conditionnelle en base : deux paiements simultanés ne donnent jamais
      // deux cadeaux.
      if (plan === 'pro_max') {
        await User.findOneAndUpdate(
          { _id: user._id, cadeauBienvenueAttribue: { $ne: true } },
          { $set: { videoOfferteDisponible: true, cadeauBienvenueAttribue: true } }
        );
      }

      // Ouvre ou prolonge la période payée. Sans cette date, un seul paiement
      // donnait accès au plan pour toujours. Un renouvellement anticipé
      // s'ajoute aux jours restants, il n'en fait perdre aucun.
      const misAJour = await User.findByIdAndUpdate(
        user._id,
        {
          $set: { plan, planExpiresAt: prolongerAbonnement(user.planExpiresAt) },
          $unset: { trialEndsAt: '' },
          $inc: { creditsBalance: creditsPlan },
        },
        { new: true }
      );
      if (!misAJour) throw new AppError('Utilisateur introuvable pour ce paiement', 404);
      await CreditTransaction.updateOne(
        { _id: reservation._id },
        { $set: { balanceAfter: misAJour.creditsBalance } }
      );
    } catch (err) {
      // Rien n'a été crédité : on libère la référence pour que la nouvelle
      // livraison du webhook puisse aboutir, au lieu de perdre le paiement.
      await CreditTransaction.deleteOne({ _id: reservation._id }).catch(() => undefined);
      throw err;
    }

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

  if (!payload.site_id) {
    throw new AppError('site_id manquant dans le webhook Chariow', 400);
  }

  const site = await Site.findById(payload.site_id);
  if (!site) throw new AppError('Site introuvable pour ce paiement', 404);

  const commissionNexai = Math.round(payload.montant * COMMISSION_NEXAI_TAUX);

  // Paiement déjà connu (rejeu) ou créé par une livraison simultanée : on ne
  // le recrée pas, mais on repasse par l'inscription au registre plus bas,
  // qui est idempotente. Un échec passé du registre est ainsi rattrapé.
  let paiement = await PaiementChariow.findOne({ referenceChariow: payload.reference });
  if (!paiement) {
    try {
      paiement = await PaiementChariow.create({
        siteId: site._id,
        referenceChariow: payload.reference,
        montant: payload.montant,
        statut: 'en_attente',
        commissionNexai,
        webhookReceivedAt: new Date(),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      paiement = await PaiementChariow.findOne({ referenceChariow: payload.reference });
      if (!paiement) throw err;
    }
  }

  // Un montant net nul ou négatif n'a rien à inscrire (et ne doit pas faire
  // rejouer le webhook indéfiniment).
  if (site.paymentMode === 'chariow' && site.userId && payload.montant - commissionNexai > 0) {
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
      // Le webhook répond en erreur : Chariow le rejouera, et l'inscription
      // (idempotente) sera retentée au lieu d'être perdue en silence.
      console.error('[chariow] Échec enregistrement ledger reversement :', err);
      throw err;
    }
  }

  return paiement;
}

export async function markPaiementPaye(paiementId: string) {
  const p = await PaiementChariow.findById(paiementId);
  if (!p) throw new AppError('Paiement introuvable', 404);
  if (p.statut === 'paye') return p;
  p.statut = 'paye';
  p.payeAt = new Date();
  await p.save();
  return p;
}
