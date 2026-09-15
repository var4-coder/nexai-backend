import { Types } from 'mongoose';
import { User, UserPlan } from '@/models/User';
import { CreditTransaction, CreditTransactionType } from '@/models/CreditTransaction';
import { AppError } from '@/middleware/errorHandler';
import { ChariowService } from './chariow.service';
import { VERROU_MINI_FILM } from '@/constants/textes-client';

const TRIAL_ALLOWED_ACTIONS: ReadonlySet<keyof typeof CREDIT_COSTS> = new Set([
  'GENERER_SITE',
  'BUSINESS_COACH',
  'VIDEO_TEST_ESSAI',
]);

export async function assertTrialNotExpired(user: {
  plan: UserPlan;
  role?: string;
  trialEndsAt?: Date;
}) {
  if (user.plan !== 'trial' || user.role === 'admin') return;
  if (user.trialEndsAt && user.trialEndsAt.getTime() < Date.now()) {
    throw new AppError(
      "Votre essai gratuit de 7 jours est terminé. Passez à un abonnement pour continuer à créer avec NexAI.",
      403
    );
  }
}

export async function getBalance(userId: Types.ObjectId | string) {
  const user = await User.findById(userId).select('creditsBalance plan trialEndsAt domainsUsed');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  const quota = PLAN_DOMAIN_QUOTA[user.plan] ?? 0;
  return {
    creditsBalance: user.creditsBalance,
    plan: user.plan,
    canPurchase: user.plan !== 'trial',
    trialEndsAt: user.trialEndsAt,
    domainsUsed: user.domainsUsed ?? 0,
    domainsIncluded: quota,
    domainsRemaining: Math.max(0, quota - (user.domainsUsed ?? 0)),
  };
}

export async function debitCredits(
  userId: Types.ObjectId | string,
  amount: number,
  type: CreditTransactionType,
  opts?: {
    relatedSiteId?: Types.ObjectId | string;
    note?: string;
    action?: keyof typeof CREDIT_COSTS;
  }
) {
  if (amount <= 0) throw new AppError('Montant de débit invalide', 400);

  const user = await User.findById(userId).select('plan role creditsBalance trialEndsAt');
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  await assertTrialNotExpired(user);

  if (user.role === 'admin') {
    await CreditTransaction.create({
      userId: user._id,
      type,
      amount: 0,
      balanceAfter: user.creditsBalance,
      relatedSiteId: opts?.relatedSiteId,
      note: opts?.note ? `admin_bypass:${opts.note}` : 'admin_bypass:0_credit',
    });
    return user.creditsBalance;
  }

  if (user.plan === 'trial') {
    const action = opts?.action;
    const allowed =
      (action && TRIAL_ALLOWED_ACTIONS.has(action)) || type === 'apercu_site';
    if (!allowed) {
      throw new AppError(
        'Cette action est réservée aux abonnés. Passez à un abonnement pour continuer.',
        403
      );
    }
  }

  const updated = await User.findOneAndUpdate(
    { _id: userId, creditsBalance: { $gte: amount } },
    { $inc: { creditsBalance: -amount } },
    { new: true }
  ).select('creditsBalance');

  if (!updated) {
    throw new AppError('Solde de crédits insuffisant', 402);
  }

  await CreditTransaction.create({
    userId: updated._id,
    type,
    amount: -amount,
    balanceAfter: updated.creditsBalance,
    relatedSiteId: opts?.relatedSiteId,
    note: opts?.note,
  });

  return updated.creditsBalance;
}

export async function creditCredits(
  userId: Types.ObjectId | string,
  amount: number,
  type: CreditTransactionType = 'achat_pack',
  opts?: { relatedSiteId?: Types.ObjectId | string; note?: string }
) {
  if (amount <= 0) throw new AppError('Montant de crédit invalide', 400);

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  user.creditsBalance += amount;
  await user.save();

  await CreditTransaction.create({
    userId: user._id,
    type,
    amount,
    balanceAfter: user.creditsBalance,
    relatedSiteId: opts?.relatedSiteId,
    note: opts?.note,
  });

  return user.creditsBalance;
}

export const CREDIT_COSTS = {
  GENERER_SITE: 12,
  GENERER_SITE_PREMIUM: 25,
  METTRE_EN_LIGNE: 15,
  MODIF_MANUELLE: 0,
  MODIF_IA: 8,
  REGENERER_SITE: 15,
  LOGO: 6,
  BUSINESS_COACH: 6,
  VIDEO_TEST_ESSAI: 10,
  PUB_STANDARD_30S: 25,
  PUB_STANDARD_60S: 63,
  PUB_STANDARD_120S: 125,
  MINI_FILM_120S_STANDARD: 140,
  MINI_FILM_120S_PREMIUM: 280,
} as const;

export function getVideoAdRelaunchCost(originalCreditsCharged: number, isFirstRelaunch: boolean): number {
  if (!isFirstRelaunch) return originalCreditsCharged;
  return Math.ceil(originalCreditsCharged / 2);
}

export const VIDEO_AD_REAL_COST_USD: Record<string, number> = {
  'voix_off:30s:standard': 2.89,
  'voix_off:60s:standard': 5.78,
  'voix_off:120s:standard': 11.57,
  'voix_off:30s:premium': 4.32,
  'voix_off:60s:premium': 8.63,
  'voix_off:120s:premium': 17.27,
  'avatar_pub:30s:standard': 1.73,
  'avatar_pub:60s:standard': 3.46,
  'avatar_pub:120s:standard': 6.92,
  'avatar_pub:30s:premium': 3.50,
  'avatar_pub:60s:premium': 6.99,
  'avatar_pub:120s:premium': 13.98,
  'mini_film:120s:standard': 10,
  'mini_film:120s:premium': 20,
};

export function estimateVideoAdRealCostUsd(mode: VideoAdMode, format: VideoAdFormat, quality: VideoAdQuality): number | null {
  return VIDEO_AD_REAL_COST_USD[`${mode}:${format}:${quality}`] ?? null;
}

export type VideoAdFormat = '30s' | '60s' | '120s';
export type VideoAdQuality = 'standard' | 'premium';
export type VideoAdMode = 'voix_off' | 'avatar_pub' | 'mini_film';

export function getVideoAdCreditCost(mode: VideoAdMode, format: VideoAdFormat, quality: VideoAdQuality): number {
  if (mode === 'mini_film') {
    if (format !== '120s') {
      throw new AppError('Le mode Mini-film/série est disponible en 120 secondes uniquement.', 400);
    }
    return quality === 'premium' ? CREDIT_COSTS.MINI_FILM_120S_PREMIUM : CREDIT_COSTS.MINI_FILM_120S_STANDARD;
  }

  const standardBase =
    format === '30s'
      ? CREDIT_COSTS.PUB_STANDARD_30S
      : format === '60s'
      ? CREDIT_COSTS.PUB_STANDARD_60S
      : CREDIT_COSTS.PUB_STANDARD_120S;

  return quality === 'premium' ? standardBase * 2 : standardBase;
}

export const VIDEO_AD_ALLOWED_PLANS: ReadonlySet<UserPlan> = new Set([
  'starter',
  'createur',
  'agence',
  'pro_max',
]);

export function assertVideoAdPlanAllowed(plan: UserPlan) {
  if (plan === 'trial') {
    throw new AppError(
      "L'outil vidéo complet est visible pendant l'essai, mais réservé aux abonnements payants. Essayez « Tester Vidéo IA » pour un aperçu gratuit, ou passez à un abonnement pour débloquer les 3 formats complets.",
      403
    );
  }
  if (!VIDEO_AD_ALLOWED_PLANS.has(plan)) {
    throw new AppError(
      'Plan non autorisé pour la génération de vidéo publicitaire.',
      403
    );
  }
}

export function assertLogoGenerationPlanAllowed(plan: UserPlan) {
  if (plan === 'trial') {
    throw new AppError(
      "La création de logo est visible pendant l'essai gratuit, mais sa génération nécessite un abonnement Créateur (ou supérieur). Passez à un abonnement pour créer votre logo.",
      403
    );
  }
  if (plan === 'starter') {
    throw new AppError(
      "La création de logo n'est pas incluse dans l'abonnement Académie. Passez à Créateur (ou supérieur) pour débloquer la génération de logo.",
      403
    );
  }
}

export function assertVideoAdModeAllowed(plan: UserPlan, mode: VideoAdMode) {
  assertVideoAdPlanAllowed(plan);
  if (mode === 'mini_film' && plan !== 'pro_max') {
    throw new AppError(VERROU_MINI_FILM, 403);
  }
}

export function getDomainPriceCredits(priceUsd: number): number {
  const rawCredits = priceUsd / 0.25 + 5;
  return Math.ceil(rawCredits / 5) * 5;
}

export const PLAN_CREDITS: Record<string, number> = {
  trial: 15,
  starter: 30,
  createur: 70,
  agence: 270,
  pro_max: 400,
} as const;

export function assertTrialVideoTestAllowed(plan: UserPlan, alreadyUsed: boolean) {
  if (plan !== 'trial') {
    throw new AppError("« Tester Vidéo IA » est réservé à l'essai gratuit.", 400);
  }
  if (alreadyUsed) {
    throw new AppError(
      "Vous avez déjà testé Vidéo IA. Passez à un abonnement pour créer vos vidéos publicitaires complètes.",
      403
    );
  }
}

export const PLAN_DOMAIN_QUOTA: Record<UserPlan, number> = {
  trial: 0,
  starter: 0,
  createur: 1,
  agence: 3,
  pro_max: 5,
};

export const PLAN_LOGO_QUOTA: Record<UserPlan, number> = {
  trial: 0,
  starter: 0,
  createur: 0,
  agence: 2,
  pro_max: 3,
};

export type LogoQuotaInfo = {
  included: number;
  used: number;
  remaining: number;
  canUseIncluded: boolean;
  creditCostIfExtra: number;
};

export function getLogoQuotaInfo(plan: UserPlan, logosUsed: number): LogoQuotaInfo {
  const included = PLAN_LOGO_QUOTA[plan] ?? 0;
  const used = logosUsed ?? 0;
  const remaining = Math.max(0, included - used);
  return {
    included,
    used,
    remaining,
    canUseIncluded: remaining > 0,
    creditCostIfExtra: CREDIT_COSTS.LOGO,
  };
}

export const PROPOSAL_MIN_SCORE = 65;

export const CREDIT_PACKS = [
  { id: 'pack_10', credits: 10, label: 'Pack 10 crédits' },
  { id: 'pack_20', credits: 20, label: 'Pack 20 crédits' },
  { id: 'pack_50', credits: 50, label: 'Pack 50 crédits' },
  { id: 'pack_100', credits: 100, label: 'Pack 100 crédits' },
  { id: 'pack_200', credits: 200, label: 'Pack 200 crédits' },
] as const;

export function assertTrialActionAllowed(plan: string, action: keyof typeof CREDIT_COSTS) {
  if (plan !== 'trial') return;
  if (!TRIAL_ALLOWED_ACTIONS.has(action)) {
    throw new AppError(
      'Cette action est réservée aux abonnés. Passez à un abonnement pour continuer.',
      403
    );
  }
}

export type DomainQuotaInfo = {
  included: number;
  used: number;
  remaining: number;
  canUseIncluded: boolean;
  creditCostIfExtra: number | null;
};

export function getDomainQuotaInfo(plan: UserPlan, domainsUsed: number): DomainQuotaInfo {
  const included = PLAN_DOMAIN_QUOTA[plan] ?? 0;
  const used = domainsUsed ?? 0;
  const remaining = Math.max(0, included - used);
  return {
    included,
    used,
    remaining,
    canUseIncluded: remaining > 0,
    creditCostIfExtra: null,
  };
}

export async function resolveDomainCostAndConsume(
  userId: Types.ObjectId | string,
  domainType: 'sous_domaine' | 'godaddy' | 'byod',
  opts?: { relatedSiteId?: Types.ObjectId | string; domainName?: string; priceUsd?: number | null }
): Promise<{ chargedCredits: number; usedQuota: boolean }> {
  if (domainType === 'sous_domaine' || domainType === 'byod') {
    return { chargedCredits: 0, usedQuota: false };
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  if (user.plan === 'trial' || user.plan === 'starter') {
    throw new AppError("L'obtention d'un nom de domaine est réservée aux abonnés pouvant créer un site.", 403);
  }

  const included = PLAN_DOMAIN_QUOTA[user.plan] ?? 0;

  const claimed = await User.findOneAndUpdate(
    { _id: user._id, domainsUsed: { $lt: included } },
    { $inc: { domainsUsed: 1 } },
    { new: true }
  );

  if (claimed) {
    return { chargedCredits: 0, usedQuota: true };
  }

  if (opts?.priceUsd == null) {
    throw new AppError(
      "Impossible de déterminer le prix réel de ce domaine. Réessayez la vérification de disponibilité.",
      502
    );
  }
  const chargedCredits = getDomainPriceCredits(opts.priceUsd);
  await debitCredits(userId, chargedCredits, 'achat_domaine', {
    relatedSiteId: opts?.relatedSiteId,
    note: opts?.domainName ? `domaine:${opts.domainName}` : 'domaine:godaddy',
  });
  await User.findByIdAndUpdate(userId, { $inc: { domainsUsed: 1 } });
  return { chargedCredits, usedQuota: false };
}

export type LaunchCharges = {
  launchCredits: number;
  domainCredits: number;
  usedDomainQuota: boolean;
};

export async function refundLaunchCharges(
  userId: Types.ObjectId | string,
  charges: LaunchCharges,
  opts?: { relatedSiteId?: Types.ObjectId | string; reason?: string }
): Promise<void> {
  const total = (charges.launchCredits || 0) + (charges.domainCredits || 0);
  if (total > 0) {
    await creditCredits(userId, total, 'ajustement_admin', {
      relatedSiteId: opts?.relatedSiteId,
      note: opts?.reason || 'remboursement_lancement_echoue',
    });
  }
  if (charges.usedDomainQuota || charges.domainCredits > 0) {
    await User.findByIdAndUpdate(userId, {
      $inc: { domainsUsed: -1 },
    });
    await User.updateOne({ _id: userId, domainsUsed: { $lt: 0 } }, { $set: { domainsUsed: 0 } });
  }
}

export class CreditsService {
  public static async purchaseCreditPack(
    userId: string,
    quantity: number,
    currency: 'XOF' | 'USD' = 'XOF'
  ) {
    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('Utilisateur introuvable.', 404);
    }

    if (user.plan === 'trial') {
      throw new AppError(
        "Option payante réservée aux abonnés. Les utilisateurs en essai gratuit ne peuvent pas acheter de crédits supplémentaires. Veuillez d'abord vous abonner.",
        403
      );
    }

    if (!quantity || quantity < 10 || quantity > 200) {
      throw new AppError('Vous devez acheter entre 10 et 200 crédits.', 400);
    }

    const unitPriceFCFA = 150;
    const totalFCFA = quantity * unitPriceFCFA;

    let finalAmount = totalFCFA;
    let finalCurrency = 'XOF';

    if (currency === 'USD') {
      const exchangeRate = 600;
      finalAmount = parseFloat((totalFCFA / exchangeRate).toFixed(2));
      finalCurrency = 'USD';
    }

    const transaction = await CreditTransaction.create({
      userId: user._id,
      type: 'achat_pack',
      amount: 0,
      balanceAfter: user.creditsBalance,
      note: `pending:${quantity}:${finalCurrency}:${finalAmount}`,
    });

    const packKey = `pack_${quantity}`;
    const paymentLink = await ChariowService.createPaymentLink({
      amount: finalAmount,
      currency: finalCurrency,
      description: `Achat de ${quantity} crédits NexAI`,
      customerEmail: user.email,
      customerFirstName: user.prenom,
      customerLastName: user.nom,
      customerPhone: user.telephone,
      customerPhoneCountry: user.telephonePays,
      productKey: packKey,
      metadata: {
        transactionId: transaction._id.toString(),
        userId: user._id.toString(),
        type: 'credit_purchase',
        quantity: String(quantity),
      },
    });

    return {
      transactionId: transaction._id,
      quantity,
      unitPrice: unitPriceFCFA,
      totalAmount: finalAmount,
      currency: finalCurrency,
      paymentLink,
    };
  }

  public static async fulfillCreditPurchase(transactionId: string, quantity?: number) {
    const transaction = await CreditTransaction.findById(transactionId);
    if (!transaction) return;

    const qty =
      quantity ??
      (transaction.note?.startsWith('pending:')
        ? parseInt(transaction.note.split(':')[1] || '0', 10)
        : 0);
    if (!qty || qty <= 0) return;
    if (transaction.note?.startsWith('completed:')) return;

    const claimed = await CreditTransaction.findOneAndUpdate(
      { _id: transactionId, note: { $regex: '^pending:' } },
      { $set: { note: `completed:${qty}` } },
      { new: true }
    );
    if (!claimed) return;

    await creditCredits(claimed.userId, qty, 'achat_pack', {
      note: 'Achat validé via Chariow',
    });
  }
}
