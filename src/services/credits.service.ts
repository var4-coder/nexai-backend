import { Types } from 'mongoose';
import { User, UserPlan } from '@/models/User';
import { CreditTransaction, CreditTransactionType } from '@/models/CreditTransaction';
import { AppError } from '@/middleware/errorHandler';
import { ChariowService } from './chariow.service';

/**
 * Service centralisé des crédits.
 * Essai (trial) : débit autorisé UNIQUEMENT pour GENERER_SITE (aperçus).
 * Tout le reste (lancement, logo, boutique, packs, domaine hors quota) → abonnés.
 */

/** Actions autorisées en essai gratuit */
const TRIAL_ALLOWED_ACTIONS: ReadonlySet<keyof typeof CREDIT_COSTS> = new Set(['GENERER_SITE']);

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
    /** Si fourni, autorise le débit en trial uniquement pour GENERER_SITE */
    action?: keyof typeof CREDIT_COSTS;
  }
) {
  if (amount <= 0) throw new AppError('Montant de débit invalide', 400);

  const user = await User.findById(userId).select('plan role creditsBalance');
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  // Compte admin : aucun débit de crédits (génération, lancer, domaine, boutique…)
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

  // Débit atomique : la condition `creditsBalance >= amount` et le `$inc`
  // sont évalués en une seule opération côté MongoDB. Deux requêtes
  // concurrentes ne peuvent donc jamais lire le même solde de départ et
  // débiter chacune de leur côté (double-dépense / lost update) — la
  // seconde ne trouvera plus le document correspondant à la condition et
  // échouera proprement avec "Solde insuffisant".
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

/** Coûts fixes (Source de Vérité C.2 / C.3) */
export const CREDIT_COSTS = {
  GENERER_SITE: 10, // qualité Normale — jusqu'à 3 aperçus
  GENERER_SITE_PREMIUM: 25, // qualité Premium — jusqu'à 3 aperçus, modèles haut de gamme
  METTRE_EN_LIGNE: 15,
  MODIF_MANUELLE: 0,
  MODIF_IA: 5,
  REGENERER_SITE: 15,
  LOGO: 5,
  DOMAINE_GODADDY: 25, // hors quota inclus

  // ══════════════════════════════════════════════════════════════════
  // Vidéo IA NexAI — 2 options produit, chacune avec sa grille de crédits.
  // Coût réel = coût fournisseur (Alexya / FalAI) + Claude Sonnet 5 (scénario/
  // script) + Grok Imagine (image de départ) + TTS ElevenLabs le cas échéant.
  // 1 crédit NexAI = 150 FCFA = $0.25 (taux 600 FCFA/$ déjà utilisé dans
  // CreditsService.purchaseCreditPack — à garder synchronisé si ce taux change).
  // ══════════════════════════════════════════════════════════════════

  // ── Option 1 : "Voix off + musique" (Alexya mode "best" silencieux +
  // narration TTS ElevenLabs + musique de fond légère). Coût réel = clips
  // Alexya (1 scène sur N remplacée gratuitement par une capture réelle du
  // site) + Grok Imagine (images de départ) + ElevenLabs (narration) +
  // Claude Sonnet 5 (script). Marge cible : 30-40% dans tous les formats
  // (vérifiée le 2026-09-01, plan Alexya Pro 255cr/$) :
  //   30s  → coût ~$2.37 → 15cr ($3.75) → marge 36.8%
  //   60s  → coût ~$5.82 → 38cr ($9.50) → marge 38.7%
  //   120s → coût ~$12.73 → 76cr ($19.00) → marge 33.0%
  VIDEO_VOIX_OFF_30S: 15,
  VIDEO_VOIX_OFF_60S: 38,
  VIDEO_VOIX_OFF_120S: 76,

  // ── Option 2a : Avatar Mode Standard (FalAI Kling Avatar v2 Standard,
  // $0.0562/s) + Grok Imagine (portrait) + ElevenLabs (narration). Marge
  // cible 30-40% (vérifiée le 2026-09-01) :
  //   30s → coût ~$1.83 → 11cr ($2.75) → marge 33.5%
  //   60s → coût ~$3.61 → 22cr ($5.50) → marge 34.4%
  VIDEO_AVATAR_STANDARD_30S: 11,
  VIDEO_AVATAR_STANDARD_60S: 22,

  // ── Option 2b : Avatar Mode Scénario (FalAI Kling Avatar v2 Pro,
  // $0.115/s, chaîné en 2 segments de 60s max). Contenu IA long à publier sur
  // les réseaux (mini-films, séries, présentations). Format unique 120s au
  // lancement. Coût réel ~$14.25 → 93cr ($23.25) → marge 38.7% (vérifiée
  // 2026-09-01, feature premium, réservée Agence/Pro Max).
  VIDEO_AVATAR_SCENARIO_120S: 93,
} as const;

/**
 * Coût d'une relance corrective d'une vidéo IA (voir video-qc.service.ts /
 * processVideoAd) : 50% du prix payé à l'origine, arrondi à l'entier
 * supérieur, pour la 1ère relance d'une vidéo donnée. Une vidéo issue d'une
 * relance qui serait elle-même dégradée n'a pas droit au tarif réduit une
 * seconde fois (`isFirstRelaunch=false`) — évite l'abus (relances en chaîne
 * à moitié prix).
 */
export function getVideoAdRelaunchCost(originalCreditsCharged: number, isFirstRelaunch: boolean): number {
  if (!isFirstRelaunch) return originalCreditsCharged;
  return Math.ceil(originalCreditsCharged / 2);
}

/**
 * Coût réel fournisseurs approximatif (USD) par mode+format, repris des
 * relevés en commentaire ci-dessus (vérifiés le 2026-09-01, plan Alexya Pro
 * 255cr/$). Utilisé uniquement pour estimer le coût perdu sur les échecs
 * remboursés dans les stats admin (/admin/video-ads/stats) — à re-mesurer
 * périodiquement si les tarifs fournisseurs changent, ce n'est pas une
 * source de facturation.
 */
export const VIDEO_AD_REAL_COST_USD: Record<string, number> = {
  'voix_off:30s': 2.37,
  'voix_off:60s': 5.82,
  'voix_off:120s': 12.73,
  'avatar_standard:30s': 1.83,
  'avatar_standard:60s': 3.61,
  'avatar_scenario:120s': 14.25,
};

export function estimateVideoAdRealCostUsd(mode: VideoAdMode, format: VideoAdFormat): number | null {
  return VIDEO_AD_REAL_COST_USD[`${mode}:${format}`] ?? null;
}

/** Formats disponibles pour l'Option 1 (voix off) et l'Avatar Standard */
export type VideoAdFormat = '30s' | '60s' | '120s';
/** Format unique du Mode Scénario au lancement (2 min) */
export type VideoAdScenarioFormat = '120s';

/** Les 3 produits vidéo IA NexAI */
export type VideoAdMode = 'voix_off' | 'avatar_standard' | 'avatar_scenario';

/**
 * Résout le coût crédits NexAI pour un mode + format donné.
 * - voix_off : 30s / 60s / 120s
 * - avatar_standard : 30s / 60s uniquement
 * - avatar_scenario : 120s uniquement (format fixe au lancement)
 */
export function getVideoAdCreditCost(mode: VideoAdMode, format: VideoAdFormat): number {
  if (mode === 'avatar_scenario') {
    if (format !== '120s') {
      throw new AppError('Le Mode Scénario est disponible en 120 secondes uniquement pour le moment.', 400);
    }
    return CREDIT_COSTS.VIDEO_AVATAR_SCENARIO_120S;
  }

  if (mode === 'avatar_standard') {
    if (format === '120s') {
      throw new AppError('L\'Avatar Mode Standard est disponible en 30s ou 60s. Utilisez le Mode Scénario pour du contenu long (120s).', 400);
    }
    const key = `VIDEO_AVATAR_STANDARD_${format.toUpperCase()}` as keyof typeof CREDIT_COSTS;
    return CREDIT_COSTS[key];
  }

  const key = `VIDEO_VOIX_OFF_${format.toUpperCase()}` as keyof typeof CREDIT_COSTS;
  return CREDIT_COSTS[key];
}

/**
 * Vidéo IA — génération à partir de Créateur uniquement.
 * Décision commerciale (visible partout, jamais masqué) :
 * - Starter (Académie) : outil VISIBLE dans l'interface, génération bloquée
 *   avec message d'upsell — sert de vitrine pour donner envie de passer à
 *   Créateur, plutôt que de cacher la fonctionnalité.
 * - Trial : idem, UI visible, génération bloquée (message upgrade + crédits).
 * - createur / agence / pro_max : OK, débit crédits.
 */
export const VIDEO_AD_ALLOWED_PLANS: ReadonlySet<UserPlan> = new Set([
  'createur',
  'agence',
  'pro_max',
]);

export function assertVideoAdPlanAllowed(plan: UserPlan) {
  if (plan === 'starter') {
    // Choix commercial : outil visible dans l'interface pour TOUS les plans
    // (y compris Académie), mais génération bloquée avec un message qui
    // donne envie de passer à l'étape supérieure plutôt qu'un simple refus.
    throw new AppError(
      "L'outil de création vidéo IA n'est pas inclus dans l'abonnement Académie. Passez à Créateur (ou supérieur) pour débloquer la génération de vidéos publicitaires — un excellent complément pour promouvoir votre futur site.",
      403
    );
  }
  if (plan === 'trial') {
    throw new AppError(
      "L'outil vidéo est visible pendant l'essai, mais la génération nécessite un abonnement Créateur (ou supérieur) et des crédits. Passez à un abonnement pour créer vos premières vidéos publicitaires.",
      403
    );
  }
  if (!VIDEO_AD_ALLOWED_PLANS.has(plan)) {
    throw new AppError(
      'Plan non autorisé pour la génération de vidéo publicitaire. Passez à Créateur ou supérieur.',
      403
    );
  }
}

/**
 * Vérifie qu'un plan a le droit de générer une vidéo pour un mode donné.
 * Le Mode Scénario n'a PAS de restriction de plan supplémentaire : ouvert aux
 * mêmes plans que le reste de l'outil vidéo (Créateur, Agence, Pro Max).
 * Décision commerciale : le plan "Agence" de NexAI est construit autour de la
 * gestion de sites clients en marque blanche (voir agency.service.ts), pas
 * autour de la création de contenu narratif — le restreindre à Agence/Pro Max
 * aurait exclu les Créateurs solo (influenceurs, petites marques), pourtant
 * la cible naturelle du contenu "série/mini-film IA". Le tri se fait par le
 * prix : 93 crédits dépasse déjà le quota mensuel complet d'un Créateur, ce
 * qui suffit à en faire un achat volontaire plutôt qu'un usage accidentel.
 */
export function assertVideoAdModeAllowed(plan: UserPlan, mode: VideoAdMode) {
  assertVideoAdPlanAllowed(plan);
}

/** Crédits offerts à l'inscription / upgrade selon le plan */
export const PLAN_CREDITS: Record<string, number> = {
  trial: 12,
  starter: 30,
  createur: 70,
  agence: 270,
  pro_max: 400,
} as const;

/**
 * Quota de noms de domaine GoDaddy inclus par plan.
 * Sous-domaine NexAI : gratuit, ne consomme pas ce quota.
 * BYOD : gratuit, ne consomme pas ce quota.
 */
export const PLAN_DOMAIN_QUOTA: Record<UserPlan, number> = {
  trial: 0,
  starter: 0,
  createur: 1,
  agence: 3,
  pro_max: 5,
};

/**
 * Quota de logos professionnels inclus par plan (gratuits, hors crédits).
 * Agence = 2, Pro Max = 3. Au-delà → 5 crédits / logo.
 */
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

/** Score minimum pour conserver un aperçu (sinon filtré → 1, 2 ou 3 visibles) */
export const PROPOSAL_MIN_SCORE = 65;

/** Packs affichés côté client (alignés seeds/credit_packs.json) */
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
  creditCostIfExtra: number;
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
    creditCostIfExtra: CREDIT_COSTS.DOMAINE_GODADDY,
  };
}

/**
 * Résout le coût d'un type de domaine au lancement (atomique pour le quota).
 * - sous_domaine / byod : gratuit
 * - godaddy : $inc domainsUsed si quota restant, sinon débit DOMAINE_GODADDY
 */
export async function resolveDomainCostAndConsume(
  userId: Types.ObjectId | string,
  domainType: 'sous_domaine' | 'godaddy' | 'byod',
  opts?: { relatedSiteId?: Types.ObjectId | string; domainName?: string }
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

  // Tentative atomique : n'incrémente que si domainsUsed < quota
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, domainsUsed: { $lt: included } },
    { $inc: { domainsUsed: 1 } },
    { new: true }
  );

  if (claimed) {
    return { chargedCredits: 0, usedQuota: true };
  }

  // Hors quota (ou race perdue) → débit crédits + incrément domainsUsed
  await debitCredits(userId, CREDIT_COSTS.DOMAINE_GODADDY, 'achat_domaine', {
    relatedSiteId: opts?.relatedSiteId,
    note: opts?.domainName ? `domaine:${opts.domainName}` : 'domaine:godaddy',
  });
  await User.findByIdAndUpdate(userId, { $inc: { domainsUsed: 1 } });
  return { chargedCredits: CREDIT_COSTS.DOMAINE_GODADDY, usedQuota: false };
}

export type LaunchCharges = {
  launchCredits: number;
  domainCredits: number;
  usedDomainQuota: boolean;
};

/** Rembourse les crédits / quota consommés si le lancement échoue côté worker */
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
    // Empêcher domainsUsed < 0
    await User.updateOne({ _id: userId, domainsUsed: { $lt: 0 } }, { $set: { domainsUsed: 0 } });
  }
}

/**
 * Achat de packs de crédits (abonnés uniquement). 1 crédit = 150 FCFA.
 */
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

    const paymentLink = await ChariowService.createPaymentLink({
      amount: finalAmount,
      currency: finalCurrency,
      description: `Achat de ${quantity} crédits NexAI`,
      customerEmail: user.email,
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

    // Marquage atomique "pending" → "completed" : si Chariow renvoie le
    // webhook deux fois (retry réseau, doublon), seule la première requête
    // trouvera encore le document à l'état "pending:" et créditera le
    // compte. La seconde ne trouvera rien (déjà "completed:") et ne
    // créditera pas une seconde fois. Sans ce verrou atomique, deux appels
    // simultanés pouvaient tous les deux lire "pending:" et déclencher un
    // double crédit.
    const claimed = await CreditTransaction.findOneAndUpdate(
      { _id: transactionId, note: { $regex: '^pending:' } },
      { $set: { note: `completed:${qty}` } },
      { new: true }
    );
    if (!claimed) return; // déjà traité par un autre appel

    await creditCredits(claimed.userId, qty, 'achat_pack', {
      note: 'Achat validé via Chariow',
    });
  }
}
