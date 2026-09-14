import { Types } from 'mongoose';
import { User, UserPlan } from '@/models/User';
import { CreditTransaction, CreditTransactionType } from '@/models/CreditTransaction';
import { AppError } from '@/middleware/errorHandler';
import { ChariowService } from './chariow.service';
import { VERROU_MINI_FILM } from '@/constants/textes-client';

/**
 * Service centralisé des crédits.
 * Essai (trial) : débit autorisé UNIQUEMENT pour GENERER_SITE (aperçus).
 * Tout le reste (lancement, logo, boutique, packs, domaine hors quota) → abonnés.
 */

/**
 * Actions autorisées en essai gratuit — Architecture v6, section 7.
 * Les 3 options de l'essai sont mutuellement exclusives par construction
 * des crédits (12+6=18, 12+10=22, 6+10=16 — toutes > 15), aucun blocage
 * supplémentaire n'est donc nécessaire entre elles.
 */
const TRIAL_ALLOWED_ACTIONS: ReadonlySet<keyof typeof CREDIT_COSTS> = new Set([
  'GENERER_SITE', // 12cr — 1 aperçu, qualité Normale uniquement
  'BUSINESS_COACH', // 6cr — coach business, disponible sur tous les plans
  'VIDEO_TEST_ESSAI', // 10cr — « Tester Vidéo IA », une seule fois
]);

/**
 * Vérifie qu'un essai gratuit n'est pas expiré.
 *
 * Sans ce contrôle, `trialEndsAt` n'était qu'une date affichée : l'essai ne
 * se terminait jamais réellement et un compte pouvait consommer ses crédits
 * indéfiniment. Appelé avant tout débit.
 */
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
    /** Si fourni, autorise le débit en trial uniquement pour GENERER_SITE */
    action?: keyof typeof CREDIT_COSTS;
  }
) {
  if (amount <= 0) throw new AppError('Montant de débit invalide', 400);

  const user = await User.findById(userId).select('plan role creditsBalance trialEndsAt');
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  // L'essai gratuit dure 7 jours : passé ce délai, plus aucun débit n'est
  // autorisé, même s'il reste des crédits au solde.
  await assertTrialNotExpired(user);

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

/**
 * Grille de crédits — Architecture NexAI v6 (10 septembre 2026).
 * 1 crédit = 150 FCFA = $0.25 (taux 600 FCFA/$).
 */
export const CREDIT_COSTS = {
  GENERER_SITE: 12, // qualité Normale
  GENERER_SITE_PREMIUM: 25, // qualité Premium
  METTRE_EN_LIGNE: 15,
  MODIF_MANUELLE: 0,
  MODIF_IA: 8, // "Améliorer avec l'IA" — note + upload photos/logo/PDF, Fable diagnostique + Sonnet applique
  REGENERER_SITE: 15,
  LOGO: 6, // hors quota inclus
  BUSINESS_COACH: 6, // "Trouver un business" — tous plans, essai compris, 1 idée/session

  // Essai gratuit uniquement — "Tester Vidéo IA", épuise le solde restant,
  // verrouillé après une utilisation (voir assertTrialVideoTestAllowed).
  VIDEO_TEST_ESSAI: 10,

  // ══════════════════════════════════════════════════════════════════
  // Vidéo IA payante — grille UNIFIÉE : même prix client pour "Vidéo pub
  // voix off" et "Avatar pub" à une durée donnée (le coût réel fournisseur
  // diffère selon le mode, voir VIDEO_AD_REAL_COST_USD plus bas — ça ne
  // change jamais le prix affiché au client). Premium = toujours ×2 du
  // Standard (voir getVideoAdCreditCost).
  // ══════════════════════════════════════════════════════════════════
  PUB_STANDARD_30S: 25,
  PUB_STANDARD_60S: 63,
  PUB_STANDARD_120S: 125,

  // Mini-film / mini-série — 120s uniquement, Pro Max exclusivement.
  MINI_FILM_120S_STANDARD: 140,
  MINI_FILM_120S_PREMIUM: 280,
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
 * Coût réel fournisseurs approximatif (USD) par mode+format+qualité — pour
 * estimer le coût perdu sur les échecs remboursés dans les stats admin
 * (/admin/video-ads/stats). Jamais une source de facturation client (la
 * grille client est unifiée, voir CREDIT_COSTS.PUB_STANDARD_*).
 *   voix_off (Alexya) : Standard "Best Quality" 280cr Alexya/clip 10s,
 *     Premium "Cinematic" sans son 420cr Alexya/clip 10s, assemblés par
 *     CLIPS_PER_FORMAT (voir video-pipeline.service.ts) + ElevenLabs.
 *   avatar_pub (FalAI Kling) : Standard $0.0562/s, Premium (Pro) $0.115/s + ElevenLabs.
 *   mini_film (FalAI Kling Pro, 120s uniquement) : ~$10 Standard / ~$20 Premium (repère admin).
 */
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

/** Formats disponibles. Mini-film : 120s uniquement (voir getVideoAdCreditCost). */
export type VideoAdFormat = '30s' | '60s' | '120s';

/** Qualité — Premium = toujours ×2 du prix Standard, quel que soit le mode. */
export type VideoAdQuality = 'standard' | 'premium';

/**
 * Les 3 modes vidéo IA NexAI (noms client, v6) :
 * - voix_off    → "Vidéo pub voix off" (Alexya)
 * - avatar_pub  → "Avatar pub" (FalAI Kling Avatar)
 * - mini_film   → "Mini-film/série" (FalAI Kling Avatar Pro, 120s uniquement, Pro Max)
 */
export type VideoAdMode = 'voix_off' | 'avatar_pub' | 'mini_film';

/**
 * Résout le coût crédits NexAI pour un mode + format + qualité donnés.
 * Grille unifiée : voix_off et avatar_pub partagent le même prix client à
 * une durée donnée (25/63/125cr Standard, ×2 Premium) — seul le coût réel
 * fournisseur diffère (voir VIDEO_AD_REAL_COST_USD). Mini-film : 120s
 * uniquement, grille dédiée (140cr Standard / 280cr Premium).
 */
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
  'starter',
  'createur',
  'agence',
  'pro_max',
]);

export function assertVideoAdPlanAllowed(plan: UserPlan) {
  if (plan === 'trial') {
    // L'essai gratuit n'a pas accès aux 3 modes payants — il a sa propre
    // option dédiée "Tester Vidéo IA" (FalAI Avatar 8s, 10cr, voir
    // assertTrialVideoTestAllowed). Outil visible ici aussi, verrouillé.
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

/**
 * Vérifie qu'un plan a le droit de GÉNÉRER un logo (mode "logo" du chat, ou
 * préférence "créer un logo" dans le mode "site"). Même politique que la
 * vidéo IA (assertVideoAdPlanAllowed) : l'outil reste visible dans le chat
 * pour TOUS les plans (y compris l'essai gratuit), mais la génération réelle
 * est réservée aux abonnements payants — avec un message d'upsell clair au
 * lieu d'un échec silencieux.
 */
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

/**
 * Vérifie qu'un plan a le droit de générer une vidéo pour un mode donné.
 * Mini-film/série (120s) est réservé Pro Max EXCLUSIVEMENT — décision
 * tranchée dans l'Architecture v6 (10 septembre 2026) : c'est un levier de
 * conversion délibéré vers le palier le plus haut, pas juste une option
 * parmi d'autres. Visible partout (icône verrouillée), jamais caché.
 */
export function assertVideoAdModeAllowed(plan: UserPlan, mode: VideoAdMode) {
  assertVideoAdPlanAllowed(plan);
  if (mode === 'mini_film' && plan !== 'pro_max') {
    throw new AppError(
      VERROU_MINI_FILM,
      403
    );
  }
}

/**
 * Convertit un prix GoDaddy réel (USD) en crédits NexAI : prix exact
 * converti (÷ $0.25/crédit) + 5 crédits de marge de sécurité, arrondi au
 * multiple de 5 crédits supérieur — absorbe les variations de taux/prix
 * GoDaddy entre la vérification de disponibilité et l'achat réel en tâche
 * de fond, sans jamais faire perdre d'argent à NexAI. Remplace l'ancien
 * ancien forfait fixe, qui ne reflétait pas le vrai prix.
 */
export function getDomainPriceCredits(priceUsd: number): number {
  const rawCredits = priceUsd / 0.25 + 5;
  return Math.ceil(rawCredits / 5) * 5;
}

/**
 * Crédits offerts à l'inscription / upgrade selon le plan.
 * trial : 15 crédits offerts UNE SEULE FOIS (pas rechargés chaque mois,
 * contrairement aux plans payants) — voir User.trialCreditsGranted pour la
 * garde qui empêche un rechargement accidentel.
 */
export const PLAN_CREDITS: Record<string, number> = {
  trial: 15,
  starter: 30,
  createur: 70,
  agence: 270,
  pro_max: 400,
} as const;

/**
 * "Tester Vidéo IA" — option dédiée à l'essai gratuit UNIQUEMENT (FalAI
 * Kling Avatar Standard, 8 secondes, avatar générique + voix personnalisée).
 * Distincte des 3 modes payants (assertVideoAdPlanAllowed les bloque tous en
 * essai) : celle-ci coûte VIDEO_TEST_ESSAI (10cr, épuise le solde restant
 * des 15cr offerts), une seule fois, jamais téléchargeable.
 */
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
  /** null = dépend du domaine choisi (prix réel GoDaddy + 5cr), pas un forfait fixe */
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
    // Pas de chiffre générique : le prix dépend du domaine choisi (prix réel
    // GoDaddy + 5cr, voir getDomainPriceCredits). null = "à calculer par domaine".
    creditCostIfExtra: null,
  };
}

/**
 * Résout le coût d'un type de domaine au lancement (atomique pour le quota).
 * - sous_domaine / byod : gratuit
 * - godaddy : $inc domainsUsed si quota restant, sinon débit du prix réel
 *   GoDaddy converti (+5cr) — priceUsd doit venir d'un checkDomainAvailability
 *   frais (juste avant l'appel), jamais un chiffre mis en cache trop longtemps.
 */
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

  // Tentative atomique : n'incrémente que si domainsUsed < quota
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, domainsUsed: { $lt: included } },
    { $inc: { domainsUsed: 1 } },
    { new: true }
  );

  if (claimed) {
    return { chargedCredits: 0, usedQuota: true };
  }

  // Hors quota (ou race perdue) → débit du prix réel + incrément domainsUsed
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
