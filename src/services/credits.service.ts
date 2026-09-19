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
  // Décision commerciale confirmée (dernier arbitrage) : LOGO et MODIF_IA
  // sont RÉSERVÉS aux abonnés payants, y compris pendant l'essai gratuit.
  // L'essai gratuit peut créer un site et trouver un business (limité par
  // ses 15 crédits), et peut modifier un site DÉJÀ CRÉÉ par voie textuelle
  // (PATCH /sites/:id/brief, 0 crédit, jamais bloqué ici) — mais ni générer
  // un logo par IA, ni modifier un site par IA. Ne pas remettre 'LOGO' ou
  // 'MODIF_IA' ici sans confirmation explicite : voir aussi
  // assertLogoGenerationPlanAllowed() et enqueueAiModify() qui appliquent
  // la même règle.
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
  // Coach business volontairement bon marché : sur l'essai gratuit (15
  // crédits), 3 + 12 = 15 permet EXACTEMENT de trouver son idée de business
  // PUIS de générer son premier site. C'est l'argument de conversion le plus
  // fort du parcours d'essai — le prospect repart avec un site réel.
  BUSINESS_COACH: 3,
  // Essai gratuit "Tester Vidéo IA" (8s) : calibré pour être EXCLUSIF du
  // parcours site. 13 crédits sur 15 ne laissent pas de quoi générer un site
  // (12), ni de quoi cumuler avec le coach : le prospect choisit entre
  // découvrir la vidéo IA ou repartir avec un site.
  VIDEO_TEST_ESSAI: 13,
  // Tarifs séparés par mode : les coûts fournisseurs réels diffèrent
  // nettement (1,73$ avatar vs 2,89$ voix off à 30s), un tarif unique
  // écraserait la marge voix off.
  // Grille arbitrée : 30s = tarif de base, 60s = ×2, 120s = ×4.
  // Premium = ×2 du standard (voir getVideoAdCreditCost).
  // Marge nette au plan le moins favorable (Créateur+, ~0,185$/crédit) :
  // Avatar ≈53%, Voix off ≈37%. La voix off est volontairement positionnée
  // plus accessible que sa marge théorique, c'est un choix commercial.
  AVATAR_PUB_30S: 20,
  AVATAR_PUB_60S: 40,
  AVATAR_PUB_120S: 80,
  VOIX_OFF_30S: 25,
  VOIX_OFF_60S: 50,
  VOIX_OFF_120S: 100,
  MINI_FILM_120S_STANDARD: 140,
  MINI_FILM_120S_PREMIUM: 280,
} as const;

/**
 * Coût d'une relance corrective.
 *
 * Une vidéo LIVRÉE (donc exploitable, avec au pire un défaut mineur signalé
 * par un badge) se relance au PLEIN TARIF, comme n'importe quelle génération :
 * un rabais ferait payer deux fois le coût fournisseur à NexAI pour des
 * anomalies cosmétiques sur une vidéo déjà utilisable.
 *
 * Le client n'est jamais lésé pour autant : une vidéo dont aucun plan n'aboutit
 * n'est pas livrée et conserve ses crédits, ouvrant une relance gratuite
 * (voir enqueueVideoAdRelaunch).
 *
 * Le paramètre isFirstRelaunch fait partie du contrat de la fonction mais
 * n'influence pas le prix.
 */
export function getVideoAdRelaunchCost(
  originalCreditsCharged: number,
  _isFirstRelaunch: boolean
): number {
  return originalCreditsCharged;
}

/**
 * Coûts fournisseurs réels par vidéo, en USD. Sert au suivi de marge et aux
 * alertes admin — jamais facturé tel quel au client.
 *
 * Moteurs vidéo (voix off) :
 *  - Standard : Alexya "best"        — inchangé
 *  - Premium  : Kling V3 Pro (fal.ai) — 0,112 $/s, audio désactivé
 *
 * Détail du Premium : 0,112 $/s × durée, plus les images de départ Grok
 * Imagine 2.0 (0,04 $ par scène de 10s) et la narration ElevenLabs.
 *   30s  = 3,36 + 0,12 + ~0,12 ≈ 3,60
 *   60s  = 6,72 + 0,24 + ~0,24 ≈ 7,20
 *   120s = 13,44 + 0,48 + ~0,48 ≈ 14,40
 *
 * Marge nette qui en résulte sur le Premium : 65% (Créateur+), 62% (Agence),
 * 61% (Pro Max) — au-dessus de la cible de 55%.
 *
 * ⚠️ Le tarif de Grok Imagine 2.0 (0,04 $ en 1K) provient des pages de suivi
 * tarifaire, pas de la documentation xAI. À confronter au tableau de bord xAI
 * après les premières générations réelles.
 */
export const VIDEO_AD_REAL_COST_USD: Record<string, number> = {
  'voix_off:30s:standard': 2.89,
  'voix_off:60s:standard': 5.78,
  'voix_off:120s:standard': 11.57,
  'voix_off:30s:premium': 3.60,
  'voix_off:60s:premium': 7.20,
  'voix_off:120s:premium': 14.40,
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

  const tarifsParMode = mode === 'avatar_pub'
    ? { '30s': CREDIT_COSTS.AVATAR_PUB_30S, '60s': CREDIT_COSTS.AVATAR_PUB_60S, '120s': CREDIT_COSTS.AVATAR_PUB_120S }
    : { '30s': CREDIT_COSTS.VOIX_OFF_30S, '60s': CREDIT_COSTS.VOIX_OFF_60S, '120s': CREDIT_COSTS.VOIX_OFF_120S };

  const standardBase = tarifsParMode[format];

  return quality === 'premium' ? standardBase * 2 : standardBase;
}

/**
 * Plans autorisés à GÉNÉRER une vidéo publicitaire.
 *
 * Starter en est volontairement exclu (décision commerciale confirmée) :
 *  - Starter est un abonnement de formation (Académie + Boutique + Coach
 *    business). Lui donner la Vidéo IA effacerait la frontière avec Créateur+
 *    et supprimerait la raison de monter en gamme.
 *  - Ses 30 crédits/mois ne couvriraient de toute façon pas une pub voix off
 *    (25 crédits) et un usage réel du plan : l'accès aurait été une promesse
 *    à moitié vide, source de frustration.
 *
 * Starter et l'essai gratuit peuvent toujours OUVRIR l'écran Vidéo IA et
 * composer un brief — seul le lancement est bloqué, avec un message d'upsell
 * (voir assertVideoAdPlanAllowed et planHasVideoAccess côté frontend).
 * L'essai gratuit dispose en plus du test 8s (VIDEO_TEST_ESSAI).
 */
export const VIDEO_AD_ALLOWED_PLANS: ReadonlySet<UserPlan> = new Set([
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
  // Règle confirmée : la création de logo par IA est réservée aux abonnés
  // payants (Créateur+, Agence, Pro Max) — l'essai gratuit ne peut PAS en
  // générer, même avec des crédits restants, et Starter (Académie
  // uniquement) reste bloqué aussi. Voir TRIAL_ALLOWED_ACTIONS (LOGO n'y
  // figure plus intentionnellement).
  if (plan === 'trial') {
    throw new AppError(
      "La création de logo par IA est réservée aux abonnés payants. Passez à un abonnement (Créateur+ ou supérieur) pour débloquer cette option.",
      403
    );
  }
  if (plan === 'starter') {
    throw new AppError(
      "La création de logo n'est pas incluse dans l'abonnement Académie. Passez à Créateur+ (ou supérieur) pour débloquer la génération de logo.",
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

/**
 * Crédits offerts à l'ouverture du plan, puis re-crédités à chaque
 * renouvellement (voir chariow.service.ts, cas 'plan_purchase').
 *
 * Grille arbitrée — le prix du crédit décroît quand on monte en gamme, pour
 * que l'upgrade soit toujours avantageux :
 *   Starter    5 000 FCFA /  30 cr = 167 FCFA/cr
 *   Créateur+ 10 000 FCFA /  80 cr = 125 FCFA/cr
 *   Agence    25 000 FCFA / 220 cr = 114 FCFA/cr
 *   Pro Max   35 000 FCFA / 320 cr = 109 FCFA/cr
 * (Pack de crédits hors abonnement : 150 FCFA/cr — voir purchaseCreditPack.)
 */
export const PLAN_CREDITS: Record<string, number> = {
  trial: 15,
  starter: 30,
  createur: 80,
  agence: 220,
  pro_max: 320,
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

/**
 * Nombre de domaines personnalisés inclus dans l'abonnement (quota À VIE,
 * jamais remis à zéro au renouvellement — voir domainsUsed sur le modèle User).
 *
 * Volontairement restreint : un domaine offert n'est pas gratuit pour NexAI,
 * c'est un achat réel chez GoDaddy. Un quota généreux coûterait plus cher que
 * l'abonnement lui-même.
 *
 * L'offre est en plus bornée par DOMAIN_FREE_BUDGET_USD (plafond de prix
 * cumulé) et FREE_DOMAIN_TLDS (extensions éligibles) : voir ces constantes.
 */
export const PLAN_DOMAIN_QUOTA: Record<UserPlan, number> = {
  trial: 0,
  starter: 0,
  createur: 0,
  agence: 1,
  pro_max: 2,
};

/**
 * Budget cumulé (en USD, prix GoDaddy réel) que l'offre gratuite prend en
 * charge sur l'ensemble des domaines inclus d'un compte. Pro Max a 2 domaines
 * inclus mais partage ce même budget : les deux additionnés ne doivent jamais
 * dépasser ce plafond.
 *
 * JAMAIS exposé au client — ni le montant, ni le mot « plafond ». Côté
 * interface, un domaine trop cher affiche simplement le complément à payer en
 * crédits (voir resolveFreeDomainCharge).
 */
export const DOMAIN_FREE_BUDGET_USD = 10;

/**
 * Extensions éligibles à l'offre gratuite.
 *
 * Volontairement limité à .com et .net : ce sont les seules extensions dont le
 * RENOUVELLEMENT reste raisonnable (~23-25 $/an). Les extensions à 0,99 $ la
 * première année (.online, .shop, .site) se renouvellent à 40-60 $/an, soit
 * 2 à 3 fois le coût réel d'un .com sur la durée. Les offrir reviendrait à
 * s'engager sur la charge récurrente la plus élevée du catalogue.
 *
 * Ces extensions restent disponibles à l'achat en crédits, sans restriction.
 */
export const FREE_DOMAIN_TLDS: readonly string[] = ['.com', '.net'];

/** Extensions proposées par NexAI (Architecture v6, section 11). */
export const NEXAI_DOMAIN_TLDS: readonly string[] = [
  '.com',
  '.site',
  '.net',
  '.online',
  '.shop',
];

/**
 * Tarifs de renouvellement STANDARD par extension (USD/an), relevés en 2026.
 * Sert de plancher : le prix réellement retenu pour un domaine donné est le
 * plus élevé entre ce tarif et le prix observé chez GoDaddy pour ce nom exact
 * (voir resolveRenewalAnnualUsd), afin de couvrir aussi bien les promos de
 * première année que les noms premium.
 *
 * À réviser périodiquement : GoDaddy ajuste ses tarifs.
 */
export const DOMAIN_RENEWAL_USD: Record<string, number> = {
  '.com': 23,
  '.net': 25,
  '.site': 40,
  '.online': 55,
  '.shop': 60,
};

/** Renouvellement annuel par défaut si l'extension est inconnue (prudent). */
const DOMAIN_RENEWAL_FALLBACK_USD = 60;

/** Extension (avec le point) d'un nom de domaine : "mon-site.com" -> ".com". */
export function getDomainTld(domain: string): string {
  const idx = domain.lastIndexOf('.');
  return idx === -1 ? '' : domain.slice(idx).toLowerCase();
}

/** true si l'extension peut être prise en charge par l'offre gratuite. */
export function isFreeEligibleTld(domain: string): boolean {
  return FREE_DOMAIN_TLDS.includes(getDomainTld(domain));
}

/**
 * Prix de renouvellement annuel RÉEL d'un domaine précis, en USD.
 *
 * Limite d'API assumée : GoDaddy n'expose pas de prix de renouvellement par
 * domaine. `/domains/available` ne renvoie que le prix d'ENREGISTREMENT, qui
 * est souvent promotionnel (0,99 $ sur .online/.shop alors que le
 * renouvellement est à 55 $). Se baser dessus reviendrait à provisionner
 * 2 crédits/mois pour une charge réelle de 19.
 *
 * On combine donc deux informations :
 *  1. `observedPriceUsd` — le prix RÉEL renvoyé par GoDaddy pour ce nom exact.
 *     C'est ce qui capture les variantes premium : un « mabanque.com » premium
 *     à 2 000 $ n'a rien à voir avec un « mabanque-pro.com » standard à 12 $,
 *     et les deux sont pourtant des .com.
 *  2. `DOMAIN_RENEWAL_USD[tld]` — le tarif de renouvellement standard de
 *     l'extension, qui rattrape les promos de première année.
 *
 * On retient le PLUS ÉLEVÉ des deux : c'est toujours le montant qui protège
 * NexAI, quel que soit le cas de figure.
 *  - .com standard acheté 5 $ en promo  -> max(5, 23)    = 23 $
 *  - .online acheté 0,99 $ en promo     -> max(0,99, 55) = 55 $
 *  - .com premium acheté 2 000 $        -> max(2000, 23) = 2 000 $
 */
export function resolveRenewalAnnualUsd(
  domain: string,
  observedPriceUsd: number | null
): number {
  const tldStandard =
    DOMAIN_RENEWAL_USD[getDomainTld(domain)] ?? DOMAIN_RENEWAL_FALLBACK_USD;
  if (observedPriceUsd == null || !Number.isFinite(observedPriceUsd)) {
    return tldStandard;
  }
  return Math.max(observedPriceUsd, tldStandard);
}

/**
 * Crédits prélevés CHAQUE MOIS, à partir de la 2ème année, pour provisionner
 * le renouvellement du domaine.
 *
 * Pourquoi : les domaines sont enregistrés dans le compte GoDaddy de NexAI.
 * Sans provisionnement, NexAI paierait indéfiniment le renouvellement de
 * domaines de clients parfois déjà partis. En étalant sur 12 mois, la charge
 * est indolore pour le client et intégralement couverte avant l'échéance.
 *
 * S'applique à TOUS les domaines — offerts comme achetés en crédits — car le
 * coût de renouvellement est le même dans les deux cas.
 *
 * Le montant dépend du domaine PRÉCIS choisi, pas seulement de son extension :
 * voir resolveRenewalAnnualUsd.
 */
export function getDomainMonthlyRenewalCredits(
  domain: string,
  observedPriceUsd: number | null = null
): number {
  const annualUsd = resolveRenewalAnnualUsd(domain, observedPriceUsd);
  return Math.ceil(annualUsd / 0.25 / 12);
}

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
  /**
   * Budget gratuit restant, en USD. Usage INTERNE uniquement (calcul du
   * complément) — ne jamais renvoyer cette valeur au client.
   */
  budgetRemainingUsd: number;
  creditCostIfExtra: number | null;
};

export function getDomainQuotaInfo(
  plan: UserPlan,
  domainsUsed: number,
  domainFreeBudgetUsedUsd = 0
): DomainQuotaInfo {
  const included = PLAN_DOMAIN_QUOTA[plan] ?? 0;
  const used = domainsUsed ?? 0;
  const remaining = Math.max(0, included - used);
  const budgetRemainingUsd = Math.max(
    0,
    DOMAIN_FREE_BUDGET_USD - (domainFreeBudgetUsedUsd ?? 0)
  );
  return {
    included,
    used,
    remaining,
    canUseIncluded: remaining > 0 && budgetRemainingUsd > 0,
    budgetRemainingUsd,
    creditCostIfExtra: null,
  };
}

/**
 * Coût de renouvellement maximal acceptable pour un domaine, en crédits/mois.
 *
 * Pourquoi un plafond : le provisionnement mensuel est proportionnel au prix
 * réel du domaine. Un nom premium à 2 000 $/an donnerait 667 crédits/mois,
 * soit plus que ce que n'importe quel abonnement distribue — le client ne
 * pourrait jamais le maintenir, et NexAI se retrouverait à financer un domaine
 * invendable. On refuse donc en amont plutôt que de vendre un engagement
 * intenable.
 *
 * 34 crédits/mois ≈ 100 $/an : couvre confortablement les 5 extensions du
 * catalogue (la plus chère, .shop, est à 60 $/an) et laisse de la marge pour
 * des noms légèrement valorisés, tout en écartant les domaines premium.
 *
 * Le client garde évidemment toute liberté sur les noms sous ce seuil.
 */
export const DOMAIN_MAX_MONTHLY_RENEWAL_CREDITS = 34;

/** true si le domaine dépasse le plafond de renouvellement supportable. */
export function isDomainTooExpensive(
  domain: string,
  observedPriceUsd: number | null
): boolean {
  return (
    getDomainMonthlyRenewalCredits(domain, observedPriceUsd) >
    DOMAIN_MAX_MONTHLY_RENEWAL_CREDITS
  );
}

/**
 * Ce que coûte RÉELLEMENT un domaine donné pour un compte donné, sans rien
 * débiter ni consommer : sert à l'affichage avant validation.
 *
 * Trois cas :
 *  - `included`   : entièrement pris en charge par l'abonnement (0 crédit)
 *  - `complement` : partiellement pris en charge, il reste X crédits à payer
 *  - `full`       : hors offre (quota épuisé, extension non éligible, ou plus
 *                   de budget) — prix normal en crédits
 *
 * Le montant du budget n'apparaît jamais dans le résultat : l'interface ne
 * montre au client qu'un nombre de crédits à compléter.
 */
export type DomainChargeKind = 'included' | 'complement' | 'full';

export type DomainCharge = {
  kind: DomainChargeKind;
  /** Crédits à débiter (0 si entièrement inclus). */
  credits: number;
  /** Part du budget gratuit que cet achat consommerait, en USD. */
  budgetSpentUsd: number;
  /** Crédits prélevés chaque mois à partir de la 2ème année. */
  monthlyRenewalCredits: number;
};

export function resolveDomainCharge(
  plan: UserPlan,
  domainsUsed: number,
  domainFreeBudgetUsedUsd: number,
  domain: string,
  priceUsd: number
): DomainCharge {
  const monthlyRenewalCredits = getDomainMonthlyRenewalCredits(domain, priceUsd);
  const info = getDomainQuotaInfo(plan, domainsUsed, domainFreeBudgetUsedUsd);

  // Hors offre : quota épuisé, ou extension non éligible au gratuit.
  if (!info.canUseIncluded || !isFreeEligibleTld(domain)) {
    return {
      kind: 'full',
      credits: getDomainPriceCredits(priceUsd),
      budgetSpentUsd: 0,
      monthlyRenewalCredits,
    };
  }

  // Entièrement couvert par le budget restant.
  if (priceUsd <= info.budgetRemainingUsd) {
    return {
      kind: 'included',
      credits: 0,
      budgetSpentUsd: priceUsd,
      monthlyRenewalCredits,
    };
  }

  // Partiellement couvert : le client complète la différence en crédits.
  const complementUsd = priceUsd - info.budgetRemainingUsd;
  return {
    kind: 'complement',
    credits: getDomainPriceCredits(complementUsd),
    budgetSpentUsd: info.budgetRemainingUsd,
    monthlyRenewalCredits,
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

  if (opts?.priceUsd == null) {
    throw new AppError(
      "Impossible de déterminer le prix réel de ce domaine. Réessayez la vérification de disponibilité.",
      502
    );
  }
  if (!opts?.domainName) {
    throw new AppError(
      'Nom de domaine manquant : impossible de calculer son coût.',
      400
    );
  }

  // Plafond de renouvellement : refusé en amont plutôt que de vendre un
  // domaine que le client ne pourra jamais maintenir (voir
  // DOMAIN_MAX_MONTHLY_RENEWAL_CREDITS).
  if (isDomainTooExpensive(opts.domainName, opts.priceUsd)) {
    throw new AppError(
      "Ce nom de domaine est trop coûteux à maintenir sur la durée. Choisissez un autre nom : nous vous proposons des alternatives disponibles immédiatement.",
      400
    );
  }

  const charge = resolveDomainCharge(
    user.plan,
    user.domainsUsed ?? 0,
    user.domainFreeBudgetUsedUsd ?? 0,
    opts.domainName,
    opts.priceUsd
  );

  // Réservation atomique du quota quand l'offre gratuite intervient (cas
  // 'included' et 'complement'). Le $lt sur domainsUsed empêche deux achats
  // simultanés de consommer le même domaine inclus.
  let usedQuota = false;
  if (charge.kind !== 'full') {
    const included = PLAN_DOMAIN_QUOTA[user.plan] ?? 0;
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, domainsUsed: { $lt: included } },
      {
        $inc: {
          domainsUsed: 1,
          domainFreeBudgetUsedUsd: charge.budgetSpentUsd,
        },
      },
      { new: true }
    );
    if (claimed) {
      usedQuota = true;
    }
  }

  // Si le quota n'a pas pu être réservé (course, ou cas 'full'), le domaine
  // est facturé au prix plein et compté hors offre.
  const chargedCredits = usedQuota
    ? charge.credits
    : getDomainPriceCredits(opts.priceUsd);

  if (chargedCredits > 0) {
    await debitCredits(userId, chargedCredits, 'achat_domaine', {
      relatedSiteId: opts?.relatedSiteId,
      note: `domaine:${opts.domainName}`,
    });
  }

  if (!usedQuota) {
    await User.findByIdAndUpdate(userId, { $inc: { domainsUsed: 1 } });
  }

  return { chargedCredits, usedQuota };
}

export type LaunchCharges = {
  launchCredits: number;
  domainCredits: number;
  usedDomainQuota: boolean;
  /**
   * Part du budget domaine offert consommée par ce lancement, à restituer en
   * cas d'échec. Sans ça, un lancement raté amputait définitivement l'offre
   * gratuite du client.
   */
  domainBudgetSpentUsd?: number;
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
      $inc: {
        domainsUsed: -1,
        domainFreeBudgetUsedUsd: -(charges.domainBudgetSpentUsd || 0),
      },
    });
    await User.updateOne({ _id: userId, domainsUsed: { $lt: 0 } }, { $set: { domainsUsed: 0 } });
    await User.updateOne(
      { _id: userId, domainFreeBudgetUsedUsd: { $lt: 0 } },
      { $set: { domainFreeBudgetUsedUsd: 0 } }
    );
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
