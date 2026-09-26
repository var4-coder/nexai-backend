import type { HydratedDocument } from 'mongoose';
import { CompteurDepense } from '@/services/cout-generation.service';
import { avecCompteurDepense, plafondDepasse, compteurCourant } from '@/services/depense-context';
import { signalerIncident } from '@/services/platform-alert.service';
import { assertRelanceGratuiteAutorisee } from '@/services/site-relaunch.service';
import { verifierClarteBrief } from '@/services/clarte-brief.service';
import { Site, ISite, ISiteProposal, SiteNiche, SiteQualityTier } from '@/models/Site';
import { Job } from '@/models/Job';
import { User, IUser } from '@/models/User';
import { pipelineQueue } from '@/jobs/queue';
import {
  debitCredits,
  CREDIT_COSTS,
  PROPOSAL_MIN_SCORE,
  resolveDomainCostAndConsume,
  refundLaunchCharges,
  type LaunchCharges,
} from '@/services/credits.service';
import {
  callGrok,
  callClaude,
  callClaudeVisionBase64,
  systemeEnTexte,
  type BlocSysteme,
  type ClaudeModel,
  type GrokModel,
  dernierUsage,
  reinitialiserUsage,
} from '@/services/ai-clients';
import { captureHtmlScreenshots } from '@/services/site-capture.service';
import { getModelForRole, getJugeVisuelPour } from '@/services/ai-role-registry';
import { generateGrokImagine, buildSiteImagePrompt } from '@/services/grok-imagine.service';
import { sourceMockupImage } from '@/services/site-image-sourcing.service';
import { verifyImageUrl } from '@/utils/verifyMedia';
import {
  chargerLibrairie,
  construireBlocCommun,
  construireBlocJuges,
  construireBlocJugeVisuel,
  construireBlocNiche,
  type BlocNiche,
} from '@/services/library.service';
import { AppError } from '@/middleware/errorHandler';
import { assertNoDuplicateJob } from '@/utils/jobGuard';
import { consigneLangue, type Langue } from '@/constants/pays';
import { assertAiKeysConfigured } from '@/services/ai-clients';
import { checkDomainAvailability } from '@/services/godaddy.service';
import { runScan1, runScan2, formatScanIssues, isLikelyTruncated } from '@/services/scan.service';
import { enregistrerVersion } from '@/services/site-versions.service';
import { sendGenerationReadyEmail } from '@/services/brevo.service';
import { env } from '@/config/env';
import { AlerteQualite } from '@/models/AlerteQualite';
import { logEvent } from '@/services/logs.service';
import { shortHash } from '@/utils/zip';
import { assertValidPaymentLink } from '@/services/payment-link.service';
import { assertBusinessCompliant } from '@/services/content-compliance.service';
import type { PaymentProvider } from '@/models/Site';

/**
 * Pipeline IA RÉEL — conforme Source de Vérité Partie A.
 *
 * Rôles — essai gratuit (1 aperçu) :
 * - Codeur      → codeur_normale (Grok 4.7 ou Sonnet 5 selon réglage admin)
 *
 * Rôles — qualité STANDARD payante (12 crédits, jusqu'à 2 aperçus) :
 * - Codeur aperçu 1 → Grok 4.7 (codeur_normale)
 * - Codeur aperçu 2 → Sonnet 5 (codeur_normale_apercu2)
 * - IA Aide         → Opus 5.5 uniquement si score < 70
 *
 * Rôles — qualité PREMIUM (25 crédits, 1 aperçu) :
 * - Codeur      → Opus 5.5 (codeur_premium, bascule admin Fable 5.1 possible)
 * - IA Aide     → Opus 5.5 uniquement si score < 70
 *
 * Les deux scans (Scan 1 = Juge Code, Scan 2 = Juge Visuel) restent aux mêmes
 * étapes du pipeline dans les deux cas ; seuls les modèles derrière changent.
 *
 * Aucun mock. Les clés XAI_API_KEY et ANTHROPIC_API_KEY doivent être
 * renseignées sur Render (Environment).
 */

// ─── Consignes : Librairie (qualité) + contrat technique (machine) ─────────
//
// Toutes les RÈGLES DE QUALITÉ viennent de la Librairie (library.service) :
// le codeur, les juges, l'IA Aide et les pages intérieures lisent le même
// texte. Ce fichier ne garde que le CONTRAT TECHNIQUE, c'est-à-dire ce dont
// la machine a besoin pour fonctionner (format de sortie, data-nexai-id,
// bouton de paiement, format JSON des juges) : le laisser modifiable dans
// l'admin permettrait de casser les générations.
//
// Ordre des blocs = ordre de mise en cache : ce qui est identique pour tous
// (bloc commun) d'abord, puis ce qui est identique pour une niche, puis ce
// qui est propre au site.

interface ContexteLibrairie {
  version: string;
  blocCommun: string;
  blocJuges: string;
  /** Sous-ensemble visuel de la Librairie pour le juge visuel (moins cher). */
  blocJugeVisuel: string;
  blocNiche: BlocNiche;
}

async function preparerContexteLibrairie(niche: string): Promise<ContexteLibrairie> {
  const lib = await chargerLibrairie();
  return {
    version: lib.version,
    blocCommun: construireBlocCommun(lib),
    blocJuges: construireBlocJuges(lib),
    blocJugeVisuel: construireBlocJugeVisuel(lib),
    blocNiche: construireBlocNiche(lib, niche),
  };
}

/** Clé de cache xAI : stable par rôle, version de Librairie et niche — jamais par site. */
function cleCacheGrok(role: string, ctx: ContexteLibrairie, avecNiche = true): string {
  return `nexai-${role}-${ctx.version}${avecNiche ? `-${ctx.blocNiche.idNiche}` : ''}`;
}

const CONTRAT_TECHNIQUE_CODEUR = `CONTRAT TECHNIQUE NEXAI (non négociable — le système en dépend) :
- Réponds UNIQUEMENT avec le document HTML complet (<!DOCTYPE html> … </html>), sans markdown ni explication.
- Page d'accueil au format démo : un seul fichier HTML autonome avec les sections #page-accueil, #page-services, #page-contact, et un script minimal sans dépendance externe pour naviguer entre sections (hash).
- Attribut data-nexai-id UNIQUE sur chaque bloc de texte modifiable : c'est grâce à lui que le client modifie ses textes.
- Bouton de paiement : si (et SEULEMENT si) le brief indique une vente en ligne, une réservation payante, des dons ou des abonnements, ajoute un bouton bien visible sur une balise <a> portant l'attribut data-nexai-payment-link (ex. <a data-nexai-payment-link href="#">Payer maintenant</a>). JAMAIS de vraie URL de paiement : le lien réel du client est posé automatiquement après coup. Libellé et moyens affichés : règles PAY de la Librairie.
- Qualité : applique STRICTEMENT la Librairie (règles communes ci-dessous + fiche de la niche). Les juges noteront ta page avec exactement ces règles, par numéro.`;

const LIBELLES_CLIENTELE: Record<string, string> = {
  locale: 'LOCALE — clients dans sa ville ou son pays → règle PAY1 (Mobile Money via Chariow/Maketou, WhatsApp, prix en FCFA)',
  digitale:
    'DIGITALE / INTERNATIONALE — clients partout en Afrique ou dans le monde → règle PAY2 (carte bancaire, PayPal…, devise adaptée)',
  mixte: 'MIXTE — clients locaux ET à distance → règle PAY3 (Mobile Money puis carte)',
};

/** Ligne « clientèle visée » transmise au codeur (règles PAY de la Librairie). */
function ligneClientele(brief: Record<string, unknown>): string {
  const c = typeof brief.clientele === 'string' ? brief.clientele : '';
  return `- Clientèle visée : ${LIBELLES_CLIENTELE[c] ?? 'non précisée → règle PAY4'}`;
}

function buildCoderSystemPrompt(
  ctx: ContexteLibrairie,
  niche: SiteNiche,
  brief: Record<string, unknown>,
  isPremium: boolean,
  pagePlan?: { slug: string; title: string }[],
  /**
   * Langue du client. Le site livré doit être rédigé dans SA langue, pas dans
   * celle de la plateforme : un commerçant ghanéen ne peut pas livrer un site
   * en français à ses propres clients.
   */
  langue: Langue = 'fr'
): BlocSysteme[] {
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI, en mode qualité Premium.'
    : 'Tu es le Codeur NexAI.';
  const isMultiPage = !!pagePlan && pagePlan.length > 1;
  const multiPageInstructions = isMultiPage
    ? `\n\nCE SITE EST MULTI-PAGES. Plan de pages du site (à respecter dans le header ET le footer de CETTE page d'accueil) : ${pagePlan!
        .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
        .join(', ')}.\nPour chaque page AUTRE que l'accueil, utilise un vrai lien <a href="slug.html">Titre</a> vers son fichier (pas une simple ancre #) ; tu peux garder des ancres # uniquement pour naviguer DANS la page d'accueil elle-même.`
    : '';
  return [
    { texte: ctx.blocCommun, cache: true },
    { texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texte}`, cache: true },
    {
      texte:
        `${identiteCodeur} Tu génères un site vitrine pro en HTML/CSS/JS autonome.\n\n` +
        `CE SITE :\n- Niche : ${niche}\n${ligneClientele(brief)}\n- Brief client (JSON) : ${JSON.stringify(brief)}` +
        `${multiPageInstructions}\n\n${consigneLangue(langue)}`,
    },
  ];
}

// ─── Juges ────────────────────────────────────────────────────────────────

const CONTRAT_SORTIE_JUGE_CODE = `Tu es le Juge Code NexAI. Tu juges le CODE HTML/CSS d'une page avec les règles de la Librairie ci-dessus (bloc commun + JUDGES.md), et la fiche de la niche fournie avec la page.

Réponds en JSON strict uniquement, sans texte autour :
{"vetos": ["M3"], "warns": ["P5"], "score_total": 0, "bloquants": ["M3 : constat court"], "erreurs": [{"erreur_id": "err_001", "regle": "C1", "composant": "...", "data_nexai_id": "...", "critere_viole": "critère du barème", "gravite": "veto|majeur|mineur", "constat": "...", "correction_attendue": "..."}]}
- "vetos" : UNIQUEMENT les numéros de règles marquées VETO dans la Librairie et réellement violées (liste vide si aucune).
- "score_total" : barème /100 du juge code (JUDGES.md), même s'il y a des vetos.
- Chaque erreur cite le numéro de la règle violée dans "regle". Pas de remarque sans règle : mets-la en conseil dans "constat" d'une erreur "mineur" avec "regle": "conseil".`;

const CONTRAT_SORTIE_JUGE_VISUEL = `Tu es le Juge Visuel NexAI. Tu juges le RENDU RÉEL d'une page (captures téléphone 390 px puis ordinateur 1 280 px) avec les règles visuelles de la Librairie ci-dessus (JUDGES.md : tests V1–V10 et barème du juge visuel ; SLOP ; LAYOUTS ; règles M et PAY), et la fiche de la niche fournie avec les captures. Tu dois TOUJOURS motiver ton verdict.

Réponds en JSON strict uniquement, sans texte autour :
{"vetos": ["V9"], "warns": [], "score_visuel": 0, "ok": true, "raisons": ["V9 : constat court"], "conseils": ["conseil concret"]}
- "vetos" : UNIQUEMENT des numéros de tests marqués VETO réellement violés (liste vide si aucun).
- "ok" : true seulement s'il n'y a aucun veto.
- "score_visuel" : barème /100 du juge visuel (JUDGES.md).`;

function systemeJugeCode(ctx: ContexteLibrairie): string {
  return `${ctx.blocCommun}\n\n${ctx.blocJuges}\n\n${CONTRAT_SORTIE_JUGE_CODE}`;
}

function systemeJugeVisuel(ctx: ContexteLibrairie): BlocSysteme[] {
  return [{ texte: `${ctx.blocJugeVisuel}\n\n${CONTRAT_SORTIE_JUGE_VISUEL}`, cache: true }];
}

function buildJudgeCodePrompt(html: string, ctx: ContexteLibrairie, niche: string): string {
  return `${ctx.blocNiche.texte}\n\nNiche du site : ${niche}\n\nHTML à juger :\n${html.slice(0, 120000)}`;
}

interface VerdictCode {
  score_total?: number;
  vetos?: string[];
  warns?: string[];
  bloquants?: string[];
  erreurs?: Array<Record<string, string>>;
}

/**
 * Appel du juge code (modèle réglé dans Équipe IA). Renvoie le verdict
 * analysé, ou null si la réponse n'est pas du JSON exploitable.
 */
async function appelerJugeCode(
  modele: string,
  ctx: ContexteLibrairie,
  html: string,
  niche: string,
  opts: { maxTokens: number; strict?: boolean }
): Promise<VerdictCode | null> {
  const raw = await callGrok(
    modele as GrokModel,
    [
      { role: 'system', content: systemeJugeCode(ctx) },
      { role: 'user', content: buildJudgeCodePrompt(html, ctx, niche) },
    ],
    { maxTokens: opts.maxTokens, temperature: opts.strict ? 0 : 0.1, cleCache: cleCacheGrok('juge-code', ctx, false) }
  );
  const verdict = parseJsonSafe<VerdictCode>(raw);
  if (!verdict) {
    console.warn(`[ia-pipeline] Juge Code : JSON invalide. raw=${raw.slice(0, 300).replace(/\n/g, ' ')}`);
  }
  return verdict;
}

function vetosDe(v: { vetos?: unknown } | null | undefined): string[] {
  return Array.isArray(v?.vetos) ? (v!.vetos as unknown[]).map(String).filter(Boolean) : [];
}

function buildRepairPrompt(html: string, errorsJson: string): string {
  return `Tu es le Réparateur NexAI. Corrige UNIQUEMENT les erreurs signalées, en commençant par celles de gravité "veto".
Chaque erreur cite le numéro de la règle de la Librairie NexAI qu'elle viole (ex. M3 = débordement horizontal à 360 px, C1 = contraste, L1 = bouton principal visible sans défiler) et la correction attendue.
Déclare ta zone d'impact (data-nexai-id modifiés + tokens CSS changés). Ne touche à rien d'autre.

Erreurs :
${errorsJson}

HTML actuel :
${html.slice(0, 120000)}

Réponds en JSON strict :
{"zone_impact":{"data_nexai_ids":[],"tokens_css_modifies":[]},"html_patch":"...html complet corrigé..."}`;
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ─── Validation qualité du brief (gate avant codeur) ──────
//
// Cette fonction est la DERNIÈRE barrière avant que le codeur IA ne reçoive
// la main. Le chat IA frontend est censé recueillir les infos de façon
// conversationnelle, mais c'est ICI, côté backend, que l'on doit vraiment
// garantir qu'un brief creux ou du texte de remplissage ne passe jamais —
// jamais se fier uniquement à une longueur totale de caractères, qui peut
// être trichée avec du texte répétitif sans aucun sens (ex: "aaaa...a").

/** Un groupe = les variantes de clés acceptées pour une information donnée */
const IDENTITY_KEYS = ['brandname', 'brand', 'nom', 'name', 'businessname', 'entreprise'];
const DESCRIPTION_KEYS = ['description', 'desc', 'activite', 'activité', 'offre', 'services'];
const AUDIENCE_KEYS = ['cible', 'audience', 'public'];

const MIN_IDENTITY_LEN = 2;
const MIN_DESCRIPTION_LEN = 40; // phrase réelle (activité + quoi/pour qui), pas un mot isolé
const MIN_AUDIENCE_LEN = 3;

/**
 * Retourne la première valeur non vide trouvée dans le brief pour l'une des
 * clés candidates (recherche insensible à la casse, par inclusion).
 */
function findFieldValue(brief: Record<string, unknown>, keyHints: string[]): string | undefined {
  for (const [key, rawValue] of Object.entries(brief)) {
    const keyLower = key.toLowerCase();
    if (!keyHints.some((hint) => keyLower.includes(hint))) continue;
    const value = typeof rawValue === 'string' ? rawValue : rawValue != null ? String(rawValue) : '';
    if (value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Un texte est "sensé" s'il atteint la longueur minimale ET n'est pas du
 * simple bourrage (une lettre répétée, ou 2 caractères distincts au max
 * répétés en boucle — ex: "aaaa...a", "abababab...").
 */
function isMeaningfulText(value: string, minLen: number): boolean {
  const trimmed = value.trim();
  if (trimmed.length < minLen) return false;

  const noSpaces = trimmed.toLowerCase().replace(/\s+/g, '');
  const uniqueChars = new Set(noSpaces).size;
  // Texte de 5+ caractères composé de 2 caractères distincts max → bourrage
  if (noSpaces.length >= 5 && uniqueChars <= 2) return false;

  // Description longue attendue : au moins 6 mots (évite "coaching business ok")
  if (minLen >= 40) {
    const words = trimmed.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 6) return false;
  }

  return true;
}

/**
 * Vérifie que le brief contient réellement les 3 informations essentielles
 * (nom de marque, description de l'activité, public cible) avec un contenu
 * sensé pour chacune. Retourne null si OK, sinon un message d'erreur clair
 * listant précisément ce qu'il manque.
 */
export function validateBriefQuality(brief: Record<string, unknown>): string | null {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return 'Le brief est vide. Précisez au minimum le nom de la marque, une description de l\'activité et le public cible.';
  }

  const identity = findFieldValue(brief, IDENTITY_KEYS);
  const description = findFieldValue(brief, DESCRIPTION_KEYS);
  const audience = findFieldValue(brief, AUDIENCE_KEYS);

  const missing: string[] = [];
  if (!identity || !isMeaningfulText(identity, MIN_IDENTITY_LEN)) {
    missing.push('le nom de la marque / entreprise');
  }
  if (!description || !isMeaningfulText(description, MIN_DESCRIPTION_LEN)) {
    missing.push("une description de l'activité plus précise (quoi tu fais / vends, pour qui — au moins une vraie phrase de 6 mots)");
  }
  if (!audience || !isMeaningfulText(audience, MIN_AUDIENCE_LEN)) {
    missing.push('le public cible');
  }

  if (missing.length > 0) {
    return `Brief incomplet, la génération ne peut pas démarrer. Il manque : ${missing.join(', ')}.`;
  }

  return null;
}

// ─── API publique ─────────────────────────────────────────

export async function enqueueSiteGeneration(
  siteId: string,
  userId: string,
  qualityTier: SiteQualityTier = 'normal'
) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);

  // Anti double-commande — AVANT tout débit (voir utils/jobGuard.ts).
  await assertNoDuplicateJob(
    siteId,
    'generation_site',
    'Une génération est déjà en cours pour ce site. Patientez quelques instants, elle arrive.'
  );

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  // Starter = Académie uniquement — pas de génération de sites
  if (user.plan === 'starter') {
    throw new AppError('Le plan Starter est réservé à l\'Académie. Passez à Créateur+ pour générer des sites.', 403);
  }
  // trial + createur + agence + pro_max OK (trial = essai avec limites côté crédits / quotas)

  // La qualité Premium est réservée aux abonnés (jamais l'essai gratuit), quel
  // que soit le solde de crédits disponible — règle métier explicite, pas
  // seulement une question de solde suffisant.
  if (qualityTier === 'premium' && user.plan === 'trial') {
    throw new AppError(
      'La qualité Premium est réservée aux abonnés. Passez à un abonnement pour y accéder.',
      403
    );
  }

  // Gate qualité brief : ne pas enqueue le codeur si brief trop vague
  const briefError = validateBriefQuality(site.brief || {});
  if (briefError) {
    throw new AppError(briefError, 400);
  }

  // Contrôle de CLARTÉ : le contrôle ci-dessus vérifie que les champs sont
  // remplis, pas qu'on puisse en tirer un site. Une demande complète mais
  // vague produit un site que les juges refusent ensuite — c'est la première
  // cause des sites ratés. On pose donc la question manquante AVANT de
  // dépenser une génération.
  const clarte = await verifierClarteBrief((site.brief || {}) as Record<string, unknown>);
  if (!clarte.clair) {
    throw new AppError(clarte.question, 400);
  }

  // Garde-fou légal/fraude — voir content-compliance.service.ts. Le chat
  // (ANTI_RULES) refuse déjà normalement en amont ; ceci protège contre un
  // appel direct à l'API qui contournerait le chat.
  const briefRecord = (site.brief || {}) as Record<string, unknown>;
  const briefDescription =
    typeof briefRecord.description === 'string' ? briefRecord.description : undefined;
  const briefBrandName =
    typeof briefRecord.brandName === 'string' ? briefRecord.brandName : undefined;
  const compliance = await assertBusinessCompliant({
    description: briefDescription,
    brandName: briefBrandName,
    niche: site.niche,
  });
  if (!compliance.allowed) {
    console.warn(`[ia-pipeline] Génération bloquée (conformité) site=${siteId} : ${compliance.reason}`);
    throw new AppError(compliance.clientMessage, 403, { complianceReason: compliance.reason });
  }

  // Pré-IA : clés présentes → aucun débit si config cassée (0 token, 0 crédit)
  assertAiKeysConfigured();

  const wantsFreeRelaunch =
    site.status === 'failed' &&
    site.freeRelaunchAvailable === true &&
    site.freeRelaunchUsed !== true &&
    site.generationRefunded !== true;

  // Annoté `number` : sans cela TypeScript le déduit comme l'union littérale
  // `12 | 25`, et refuse d'y réaffecter le montant réellement facturé lors
  // d'une relance gratuite (qui peut différer si un tarif a changé depuis).
  let creditCost: number =
    qualityTier === 'premium' ? CREDIT_COSTS.GENERER_SITE_PREMIUM : CREDIT_COSTS.GENERER_SITE;
  const creditAction = qualityTier === 'premium' ? 'GENERER_SITE_PREMIUM' : 'GENERER_SITE';
  let creditsBalanceAfter: number | undefined;
  let isClientFreeRelaunch = false;

  if (wantsFreeRelaunch) {
    assertRelanceGratuiteAutorisee(site);
    isClientFreeRelaunch = true;
    creditCost = site.creditsChargedForGeneration || creditCost;
    site.freeRelaunchUsed = true;
    site.freeRelaunchAvailable = false;
  } else {
    creditsBalanceAfter = await debitCredits(userId, creditCost, 'apercu_site', {
      relatedSiteId: siteId,
      action: creditAction,
    });
    site.creditsChargedForGeneration = creditCost;
    site.depenseCumuleeUsd = 0;
    site.autoRetryUsed = false;
    site.freeRelaunchAvailable = false;
    site.freeRelaunchUsed = false;
    site.freeRelaunchAvailableAt = undefined;
    site.generationRefunded = false;
  }

  site.qualityTier = qualityTier;
  site.status = 'generating';
  site.generationStartedAt = new Date();
  site.lastError = undefined;
  site.clientMessage = undefined;
  await site.save();

  const bullJob = await pipelineQueue.add(
    'generation_site',
    {
      siteId,
      userId,
      type: 'generation_site',
      creditsCharged: creditCost,
      skipDebit: isClientFreeRelaunch,
      freeRelaunchUsed: isClientFreeRelaunch,
    },
    {
      jobId: `gen_${siteId}_${Date.now()}`,
      // Relance client : plus aucune reprise auto — 1 seul essai.
      attempts: isClientFreeRelaunch ? 1 : 2,
    }
  );

  await Job.create({
    type: 'generation_site',
    siteId: site._id,
    status: 'queued',
    bullJobId: String(bullJob.id),
    meta: { creditsCharged: creditCost, freeRelaunchUsed: isClientFreeRelaunch },
  });

  return { jobId: bullJob.id, status: 'queued', creditsBalance: creditsBalanceAfter };
}

/**
 * Modification IA d'un site existant (coût 8 crédits).
 * Charge le site + brief + HTML choisi, applique l'instruction via Sonnet 5
 * (3 tours max : appliquer → vérifier → rattrapage limité).
 */
export async function enqueueAiModify(siteId: string, userId: string, instruction: string) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);

  // Anti double-commande — AVANT tout débit (voir utils/jobGuard.ts).
  await assertNoDuplicateJob(
    siteId,
    'modification_structurelle',
    'Une amélioration par IA est déjà en cours sur ce site. Attendez son résultat avant d\'en lancer une autre.'
  );

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  if (user.plan === 'starter') {
    throw new AppError("Le plan Starter est réservé à l'Académie. Passez à Créateur+ pour modifier un site.", 403);
  }
  // Règle confirmée : la modification IA d'un site est réservée aux abonnés
  // payants, y compris pendant l'essai gratuit. La modification TEXTUELLE
  // (édition directe du brief, sans IA) reste libre et gratuite pour
  // l'essai via PATCH /sites/:id/brief — ce n'est pas ce chemin de code ici.
  if (user.plan === 'trial') {
    throw new AppError(
      "La modification d'un site par IA est réservée aux abonnés payants. Vous pouvez modifier le texte de votre site directement (gratuit), ou passer à un abonnement pour débloquer la modification par IA.",
      403
    );
  }

  const trimmed = (instruction || '').trim();
  if (trimmed.length < 5) {
    throw new AppError('Précisez l\'instruction de modification (au moins quelques mots).', 400);
  }

  // Brief doit être utilisable (contexte)
  const briefError = validateBriefQuality(site.brief || {});
  if (briefError) {
    throw new AppError(
      'Le brief du site est incomplet — impossible de modifier de façon cohérente. Complétez le brief d\'abord.',
      400
    );
  }

  if (!site.chosenProposalId && (!site.proposals || site.proposals.length === 0)) {
    throw new AppError('Aucune proposition générée sur ce site — générez d\'abord des aperçus.', 400);
  }

  const creditsBalanceAfter = await debitCredits(userId, CREDIT_COSTS.MODIF_IA, 'modification_niveau2', {
    relatedSiteId: siteId,
    action: 'MODIF_IA',
    note: `ai-modify:${trimmed.slice(0, 80)}`,
  });

  site.status = 'generating';
  site.generationStartedAt = new Date();
  await site.save();

  const bullJob = await pipelineQueue.add(
    'ai_modify',
    { siteId, userId, type: 'ai_modify', instruction: trimmed },
    { jobId: `mod_${siteId}_${Date.now()}` }
  );

  await Job.create({
    type: 'modification_structurelle',
    siteId: site._id,
    status: 'queued',
    bullJobId: String(bullJob.id),
    meta: { instruction: trimmed },
  });

  return { jobId: bullJob.id, status: 'queued', creditsBalance: creditsBalanceAfter };
}

/**
 * Traitement worker : modification IA du HTML choisi (ou première proposition).
 */
export async function processAiModify(siteId: string, instruction: string): Promise<void> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error(`Site ${siteId} introuvable`);

  // Archive l'état AVANT modification — c'est ce qui rend le bouton
  // « Restaurer cette version » possible si l'IA casse le site
  // (Architecture v6, section 10). Non bloquant en cas d'échec.
  await enregistrerVersion(site._id, 'modification_ia', instruction.slice(0, 200));

  const chosenId = site.chosenProposalId;
  let target = chosenId
    ? site.proposals.find((p) => p.versionId === chosenId)
    : site.proposals[0];
  if (!target || !target.htmlDemo) {
    // Fallback : régénération légère si pas de HTML
    site.status = 'failed';
    await site.save();
    throw new Error('HTML source introuvable pour ai-modify');
  }

  const briefCompact = JSON.stringify(site.brief || {}).slice(0, 2500);

  const extraireHtml = (raw: string) =>
    raw.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

  const problemesPage = (html: string): string[] => {
    const s1 = runScan1(html);
    const s2 = runScan2(html);
    const msgs = [
      ...(!s1.ok ? s1.issues.map((i) => i.message) : []),
      ...(!s2.ok ? s2.issues.map((i) => i.message) : []),
    ];
    if (isLikelyTruncated(s1) || isLikelyTruncated(s2) || !html.includes('</html>')) {
      msgs.push('HTML incomplet ou tronqué');
    }
    return [...new Set(msgs)].slice(0, 8);
  };

  const systemAppliquer = (pageLabel: string) =>
    `Tu es le Codeur NexAI. Tu modifies un site HTML existant selon l'instruction client.
RÈGLES :
- Conserve la structure, les data-nexai-id, et le design global sauf si l'instruction demande explicitement le contraire.
- Applique l'instruction de façon cohérente (même identité visuelle). NE CASSE PAS les liens de navigation déjà présents.
- Un seul fichier HTML autonome en sortie, page "${pageLabel}" uniquement.
- Brief : ${briefCompact}
- Niche : ${site.niche}
Réponds UNIQUEMENT avec le HTML complet modifié, sans markdown.`;

  const systemCorriger = (pageLabel: string) =>
    `Tu répares un HTML déjà modifié. Tu ne changes QUE ce qui est cassé ou manquant.
Page : ${pageLabel}. Conserve data-nexai-id, navigation, et le reste du design.
Réponds UNIQUEMENT avec le HTML complet corrigé, sans markdown.`;

  async function modifyPageHtml(
    pageHtml: string,
    pageLabel: string,
    opts?: { verifierInstruction?: boolean }
  ): Promise<string> {
    // Tour 1 — appliquer l'instruction.
    const raw1 = await callClaude(
      'claude-sonnet-5',
      systemAppliquer(pageLabel),
      [
        {
          role: 'user',
          content: `Instruction : ${instruction}\n\nHTML actuel :\n${pageHtml.slice(0, 80000)}`,
        },
      ],
      { maxTokens: 16000 }
    );
    let html = extraireHtml(raw1);
    if (!html || html.length < 200) html = pageHtml;

    let bugs = problemesPage(html);

    // Tour 2 — vérifier. Audit court si le scan est propre ; sinon correction ciblée.
    if (bugs.length === 0 && opts?.verifierInstruction) {
      const audit = await callClaude(
        'claude-sonnet-5',
        `Tu vérifies qu'une modification HTML a bien été appliquée, sans rien casser.
Réponds UNIQUEMENT en JSON compact : {"ok":true} ou {"ok":false,"problemes":["..."]}.
Pas de HTML.`,
        [
          {
            role: 'user',
            content: `Instruction demandée : ${instruction}\n\nHTML modifié (extrait) :\n${html.slice(0, 14000)}`,
          },
        ],
        { maxTokens: 400 }
      );
      try {
        const parsed = JSON.parse(audit.replace(/```json?\s*/i, '').replace(/```/g, '').trim()) as {
          ok?: boolean;
          problemes?: string[];
        };
        if (parsed.ok === false && Array.isArray(parsed.problemes) && parsed.problemes.length > 0) {
          bugs = parsed.problemes.slice(0, 6);
        }
      } catch {
        // Audit illisible : on ne relance pas « au cas où ».
      }
    }

    if (bugs.length > 0) {
      const raw2 = await callClaude(
        'claude-sonnet-5',
        systemCorriger(pageLabel),
        [
          {
            role: 'user',
            content: `Problèmes à corriger :\n- ${bugs.join('\n- ')}\n\nInstruction d'origine : ${instruction}\n\nHTML :\n${html.slice(0, 80000)}`,
          },
        ],
        { maxTokens: 16000 }
      );
      const fixed = extraireHtml(raw2);
      if (fixed && fixed.length >= 200) html = fixed;
    }

    // Tour 3 — uniquement s'il reste des erreurs détectables. Jamais de 4e tour.
    const reste = problemesPage(html);
    if (reste.length > 0) {
      const raw3 = await callClaude(
        'claude-sonnet-5',
        systemCorriger(pageLabel),
        [
          {
            role: 'user',
            content: `Dernier tour. Corrige uniquement :\n- ${reste.join('\n- ')}\n\nHTML :\n${html.slice(0, 80000)}`,
          },
        ],
        { maxTokens: 12000 }
      );
      const last = extraireHtml(raw3);
      if (last && last.length >= 200) html = last;
    }

    return html;
  }

  const idx = site.proposals.findIndex((p) => p.versionId === target!.versionId);
  if (idx < 0) throw new Error('Proposition introuvable pour ai-modify');

  // Page d'accueil — comportement historique, toujours modifiée.
  const newHome = await modifyPageHtml(target.htmlDemo!, 'Accueil', { verifierInstruction: true });
  site.proposals[idx].htmlDemo = newHome;

  // Pages secondaires (sites multi-pages, voir PAGES_PAR_NICHE) : chacune
  // reçoit la MÊME instruction pour rester cohérente avec l'accueil. Best
  // effort par page — une page qui échoue est simplement conservée telle
  // quelle plutôt que de faire échouer toute la modification.
  const existingPages = target.pages || [];
  if (existingPages.length > 0) {
    const updatedPages: NonNullable<ISiteProposal['pages']> = [];
    for (const page of existingPages) {
      try {
        const newHtml = await modifyPageHtml(page.html, page.title);
        updatedPages.push({ ...page, html: newHtml });
      } catch (err) {
        console.warn(`[ia-pipeline] ai-modify page "${page.slug}" échouée, page conservée telle quelle`, err);
        updatedPages.push(page);
      }
    }
    site.proposals[idx].pages = updatedPages;
    site.markModified('proposals');
  }

  site.proposals[idx].dataNexaiIds = Array.from(
    new Set([
      ...extractDataNexaiIds(newHome),
      ...(site.proposals[idx].pages || []).flatMap((p) => extractDataNexaiIds(p.html)),
    ])
  );

  if (!site.chosenProposalId) {
    site.chosenProposalId = target.versionId;
  }
  site.status = site.status === 'launched' || site.domainName ? 'ready' : 'ready';
  // Si déjà lancé, on reste ready (redeploy manuel / futur job)
  if (site.domainName || site.netlifySiteId) {
    site.status = 'ready';
  }
  await site.save();
}

// ─── Plan de pages par niche (sites multi-pages) ──────────────────────────
// Détermine automatiquement si un site a besoin de plusieurs pages distinctes
// (au-delà de l'accueil), selon sa niche — sans configuration à faire côté
// client. Le brief peut surcharger ce plan via `brief.pages` (tableau
// [{slug, title}]) pour les cas particuliers. Toute niche absente de cette
// map reste en page unique (comportement historique inchangé).
export const PAGES_PAR_NICHE: Partial<Record<SiteNiche, { slug: string; title: string }[]>> = {
  immobilier_architecture: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'biens', title: 'Nos biens' },
    { slug: 'contact', title: 'Contact' },
  ],
  ecommerce_mode: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'boutique', title: 'Boutique' },
    { slug: 'contact', title: 'Contact' },
  ],
  restaurant_gastronomie: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'menu', title: 'Notre menu' },
    { slug: 'contact', title: 'Réservation & Contact' },
  ],
  hotellerie_evenementiel: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'chambres', title: 'Chambres & Prestations' },
    { slug: 'contact', title: 'Réservation & Contact' },
  ],
  education_formation: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'formations', title: 'Nos formations' },
    { slug: 'contact', title: 'Contact' },
  ],
  sante_bienetre: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'services', title: 'Nos services' },
    { slug: 'contact', title: 'Rendez-vous & Contact' },
  ],
  services_locaux: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'services', title: 'Nos prestations' },
    { slug: 'contact', title: 'Contact' },
  ],
};

/**
 * Résout le plan de pages effectif pour un site : priorité au brief client
 * (`brief.pages`, tableau [{slug,title}] optionnel) sinon plan par défaut de
 * la niche, sinon page unique 'index'. Toujours au moins l'entrée 'index'.
 */
export function resolvePagePlan(
  niche: SiteNiche,
  brief: Record<string, unknown>
): { slug: string; title: string }[] {
  const customRaw = (brief as { pages?: unknown }).pages;
  if (Array.isArray(customRaw) && customRaw.length > 0) {
    const custom = customRaw
      .filter((p): p is { slug?: unknown; title?: unknown } => !!p && typeof p === 'object')
      .map((p) => ({
        slug: String((p as { slug?: unknown }).slug || '').trim(),
        title: String((p as { title?: unknown }).title || '').trim(),
      }))
      .filter((p) => p.slug.length > 0);
    if (custom.length > 0) {
      if (!custom.some((p) => p.slug === 'index')) {
        custom.unshift({ slug: 'index', title: 'Accueil' });
      }
      return custom;
    }
  }
  return PAGES_PAR_NICHE[niche] || [{ slug: 'index', title: 'Accueil' }];
}

function buildSecondaryPageSystemPrompt(
  ctx: ContexteLibrairie,
  niche: SiteNiche,
  brief: Record<string, unknown>,
  isPremium: boolean,
  homepageHtml: string,
  page: { slug: string; title: string },
  allPages: { slug: string; title: string }[]
): BlocSysteme[] {
  // Pas de nom de modèle : le modèle réel se règle dans l'admin (Équipe IA).
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI, en mode qualité Premium.'
    : 'Tu es le Codeur NexAI.';
  const navLinks = allPages
    .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
    .join(', ');

  return [
    { texte: ctx.blocCommun, cache: true },
    { texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texte}`, cache: true },
    {
      texte: `${identiteCodeur} Tu génères la page "${page.title}" (slug: ${page.slug}) d'un site multi-pages déjà commencé. Pour cette page, le format démo à sections (#page-accueil…) du contrat ne s'applique pas : c'est un document HTML complet et autonome, <!DOCTYPE html> inclus.

RÈGLE ABSOLUE DE COHÉRENCE : cette page fait partie du MÊME site que la page d'accueil ci-dessous. Réutilise exactement le même header/navigation, le même footer, la même palette de couleurs, la même typographie, les mêmes tokens CSS et le même contrat data-nexai-id que la page d'accueil. Ne change JAMAIS l'identité visuelle.

Navigation du site (toutes les pages, à inclure dans le header de CETTE page, avec des liens <a href="..."> vers chaque fichier) : ${navLinks}.

Niche : ${niche}
${ligneClientele(brief)}
Brief client : ${JSON.stringify(brief)}

Page d'accueil du site (référence de style à reproduire strictement, ne PAS la recopier telle quelle — génère le contenu propre à "${page.title}") :
${homepageHtml.slice(0, 12000)}

Réponds uniquement avec le HTML complet et autonome de la page "${page.title}".`,
    },
  ];
}

/**
 * Génère les pages secondaires (au-delà de l'accueil) pour une proposition
 * déjà retenue, quand la niche/le brief l'exigent (voir resolvePagePlan).
 * Best-effort : n'importe quelle page qui échoue est simplement ignorée
 * (le site reste fonctionnel avec les pages déjà générées), et ne fait
 * jamais échouer processGeneration.
 */
async function generateSecondaryPagesForProposal(
  proposal: ISiteProposal,
  pagePlan: { slug: string; title: string }[],
  site: { niche: SiteNiche; brief: Record<string, unknown> },
  ctx: ContexteLibrairie,
  isPremium: boolean
): Promise<void> {
  const homepageHtml = proposal.htmlDemo || '';
  const secondaryPlan = pagePlan.filter((p) => p.slug !== 'index');
  if (secondaryPlan.length === 0 || !homepageHtml) return;

  const pages: NonNullable<ISiteProposal['pages']> = [];
  // Modèles réglés dans Équipe IA (plus aucun nom écrit en dur ici).
  const modelePages = await getModelForRole(isPremium ? 'codeur_pages_premium' : 'codeur_pages_normale');
  const modeleJugeCode = await getModelForRole('juge_code');

  for (const page of secondaryPlan) {
    if (plafondDepasse()) {
      console.warn(`[ia-pipeline] Plafond de dépense atteint — page "${page.slug}" non générée.`);
      break;
    }
    try {
      const prompt = buildSecondaryPageSystemPrompt(
        ctx,
        site.niche,
        site.brief,
        isPremium,
        homepageHtml,
        page,
        pagePlan
      );
      let html = await appelerCodeur(modelePages, prompt, `Génère la page ${page.slug}.`, {
        maxTokens: 16000,
        temperature: 0.4,
        cleCache: cleCacheGrok('pages', ctx),
        // Les pages s'enchaînent avec le même début de consigne : la 2e
        // page relit la Librairie depuis le cache.
        reutilisationPrevue: secondaryPlan.length > 1,
      });
      html = html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

      // Chaque page intérieure est JUGÉE comme l'accueil (décision admin
      // 26/09/2026) : veto puis note /100, réparation si besoin, re-jugement.
      let score: number | undefined;
      let vetos: string[] = [];
      try {
        let verdict = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2500 });
        if (verdict) {
          score = typeof verdict.score_total === 'number' ? verdict.score_total : undefined;
          vetos = vetosDe(verdict);
          if (!plafondDepasse() && (vetos.length > 0 || (score ?? 0) < 80)) {
            const repRaw = await callGrok(
              'grok-build-0.1',
              [
                { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
                {
                  role: 'user',
                  content: buildRepairPrompt(html, JSON.stringify({ vetos, erreurs: verdict.erreurs ?? [] })),
                },
              ],
              { maxTokens: 16000, temperature: 0.2 }
            );
            const rep = parseJsonSafe<{ html_patch: string }>(repRaw);
            const patch = rep?.html_patch?.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
            if (patch && runScan2(patch).ok) {
              html = patch;
              verdict = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2000 });
              if (verdict) {
                score = typeof verdict.score_total === 'number' ? verdict.score_total : score;
                vetos = vetosDe(verdict);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[ia-pipeline] Jugement de la page "${page.slug}" indisponible`, err);
      }
      if (vetos.length > 0 && score !== undefined) score = Math.min(score, 59);

      pages.push({ slug: page.slug, title: page.title, html, score, vetos });
    } catch (err) {
      console.warn(`[ia-pipeline] Page secondaire "${page.slug}" non générée`, err);
    }
  }

  if (pages.length > 0) {
    proposal.pages = pages;
    proposal.pagesMeta = pagePlan.map((p) => ({
      slug: p.slug,
      title: p.title,
      description: p.slug === 'index' ? proposal.pagesMeta?.[0]?.description || '' : '',
    }));
    proposal.dataNexaiIds = Array.from(
      new Set([...(proposal.dataNexaiIds || []), ...pages.flatMap((p) => extractDataNexaiIds(p.html))])
    );
  }
}

/**
 * Génération réelle des propositions (appelé par le worker).
 *
 * `forceVariation` est passé lors d'une RELANCE après refus (admin ou
 * Fable) : on ne rejoue alors pas le même tirage, sinon on retomberait
 * très probablement sur le même résultat raté. Le Codeur reçoit la
 * consigne explicite de changer de direction artistique et de composition.
 */
/**
 * Appelle le codeur via la BONNE API, déterminée par le nom du modèle.
 *
 * Indispensable : les codeurs sont alternables depuis l'admin entre Grok
 * (API xAI) et Claude (API Anthropic). Choisir l'API selon la qualité
 * demandée enverrait un nom de modèle Claude à l'API de xAI dès qu'un
 * codeur est basculé — et toutes les générations échoueraient.
 */
/**
 * Compteur de la génération en cours.
 *
 * Variable de module plutôt que paramètre passé de fonction en fonction :
 * les appels IA sont dispersés dans tout le pipeline, et les traverser tous
 * pour transmettre un compteur aurait touché des dizaines de signatures — un
 * risque inutile sur du code qui fonctionne.
 *
 * Chaque génération s'exécute dans un AsyncLocalStorage isolé
 * (voir depense-context.ts) : deux jobs ou deux aperçus parallèles
 * ne mélangent plus leurs comptes.
 */
function compterDernierAppel(): void {
  // L'enregistrement se fait désormais dans ai-clients via enregistrerUsage().
  reinitialiserUsage();
}

async function appelerCodeur(
  modele: string,
  systemPrompt: string | BlocSysteme[],
  instruction: string,
  opts: { maxTokens: number; temperature: number; cleCache?: string; reutilisationPrevue?: boolean }
): Promise<string> {
  // Claude reçoit les blocs (mise en cache explicite) ; Grok reçoit le même
  // texte d'un seul tenant, dans le même ordre (cache automatique xAI sur
  // le début commun, regroupé par la clé de cache).
  const lancer = (m: string) =>
    m.startsWith('claude-')
      ? callClaude(m as ClaudeModel, systemPrompt, [{ role: 'user', content: instruction }], opts)
      : callGrok(
          m as GrokModel,
          [
            { role: 'system', content: systemeEnTexte(systemPrompt) },
            { role: 'user', content: instruction },
          ],
          opts
        );

  try {
    const resultat = await lancer(modele);
    compterDernierAppel();
    return resultat;
  } catch (err) {
    // ── Bascule automatique, UNIQUEMENT sur indisponibilité ──
    //
    // Un fournisseur injoignable, saturé ou trop lent ne doit pas faire
    // échouer une génération que l'autre famille de modèles peut produire.
    // La bascule est donc autorisée pour CE SEUL type d'erreur.
    //
    // Toute autre cause — clé invalide, crédits épuisés, refus du modèle,
    // bug — est relancée telle quelle : la masquer en changeant de modèle
    // empêcherait de la voir et de la corriger.
    const secours = modeleDeSecours(modele);
    if (!secours || !estIndisponibilite(err)) throw err;

    console.warn(
      `[ia-pipeline] ${modele} indisponible — bascule automatique sur ${secours}. ` +
        `Cause : ${String((err as Error)?.message).slice(0, 120)}`
    );
    const resultat = await lancer(secours);
    compterDernierAppel();
    return resultat;
  }
}

/**
 * Modèle de secours d'une famille à l'autre : si Grok est indisponible on
 * passe à Claude, et inversement. Deux familles, deux fournisseurs, deux
 * infrastructures — une panne de l'un n'affecte pas l'autre.
 */
function modeleDeSecours(modele: string): string | null {
  if (modele.startsWith('claude-')) return 'grok-4.7';
  return 'claude-sonnet-5';
}

/**
 * L'échec vient-il d'une INDISPONIBILITÉ du fournisseur ?
 *
 * Volontairement restrictif : seuls les délais dépassés, coupures réseau et
 * codes de saturation ou de panne serveur comptent. Une clé invalide ou des
 * crédits épuisés ne sont PAS une indisponibilité — basculer masquerait le
 * problème au lieu de le signaler.
 */
function estIndisponibilite(err: unknown): boolean {
  const e = err as { name?: string; message?: string; statusCode?: number; cause?: { code?: string } };
  const statut = e?.statusCode;
  if (statut === 401 || statut === 403 || statut === 400 || statut === 402) return false;

  const texte = `${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.name ?? ''}`.toLowerCase();
  if (/manquante|invalid[_ ]?api|credit balance|quota|insufficient/.test(texte)) return false;

  return (
    e?.name === 'AbortError' ||
    e?.name === 'TimeoutError' ||
    statut === 429 ||
    statut === 500 ||
    statut === 502 ||
    statut === 503 ||
    statut === 504 ||
    /fetch failed|econnreset|etimedout|enotfound|econnrefused|und_err|socket|timeout|overloaded/.test(texte)
  );
}

export async function processGeneration(
  siteId: string,
  opts?: { forceVariation?: boolean; refabricationFable?: boolean }
): Promise<ISiteProposal[]> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error(`Site ${siteId} introuvable`);

  const owner = await User.findById(site.userId);
  const plan = owner?.plan || 'trial';
  const isPremium = site.qualityTier === 'premium';

  // Compteur de dépense : additionne le coût RÉEL de chaque appel, d'après
  // les tokens que les fournisseurs facturent. Il borne aussi l'exposition —
  // un fournisseur au comportement anormal ne peut pas faire filer la note.
  const depense = new CompteurDepense(
    plan === 'trial' ? 'essai' : isPremium ? 'premium' : 'normale'
  );
  depense.reprendre(site.depenseCumuleeUsd || 0);
  reinitialiserUsage();
  return avecCompteurDepense(depense, () =>
    executerGeneration(site, owner, plan, isPremium, depense, opts)
  );
}

async function executerGeneration(
  // Type explicite : l'inférence par `Awaited<ReturnType<typeof
  // Site.findById>>` se résout en objet vide avec Mongoose, ce qui
  // invalidait tous les accès aux champs du site.
  site: HydratedDocument<ISite>,
  owner: HydratedDocument<IUser> | null,
  plan: string,
  isPremium: boolean,
  depense: CompteurDepense,
  opts?: { forceVariation?: boolean; refabricationFable?: boolean }
): Promise<ISiteProposal[]> {
  const siteId = String(site._id);
  const forceVariation = opts?.forceVariation === true;
  const refabricationFable = opts?.refabricationFable === true;

  const previewCount = isPremium || plan === 'trial' ? 1 : 2;
  // Librairie : UNE lecture pour toute la génération. Codeur, juges, IA Aide
  // et pages intérieures travaillent ainsi exactement sur la même version,
  // enregistrée sur le site (comparaison avant/après, test A/B).
  const ctx = await preparerContexteLibrairie(site.niche);
  site.libraryVersion = ctx.version;
  if (!ctx.blocNiche.ficheTrouvee) {
    console.warn(
      `[ia-pipeline] Librairie : aucune fiche pour la niche « ${site.niche} » ` +
        `(id Librairie « ${ctx.blocNiche.idNiche} ») — dernier filet utilisé.`
    );
  }
  // Calculé avant la génération de l'accueil pour que son header/footer
  // pointe déjà vers les bonnes pages (voir PAGES_PAR_NICHE / resolvePagePlan).
  const pagePlan = resolvePagePlan(site.niche, site.brief);
  // Langue du propriétaire du site : le contenu livré doit être dans SA langue
  // (voir consigneLangue), pas dans celle de la plateforme.
  const langueClient = (owner?.langue as Langue) ?? 'fr';
  const proposals: ISiteProposal[] = [];

  // 1 aperçu : essai (réglage admin Grok 4.7 ou Sonnet 5) et Premium (Opus 5.5, Fable en alternative).
  // 2 aperçus : Standard payant, Grok 4.7 + Sonnet 5, en parallèle.
  const modeleCodeurParApercu: Record<number, string> = {};

  const runOnePreview = async (i: number): Promise<ISiteProposal | null> => {
    const systemPrompt = buildCoderSystemPrompt(
      ctx,
      site.niche,
      site.brief,
      isPremium,
      pagePlan,
      langueClient
    );
    // Plafond de dépense : contrôlé AVANT d'engager un nouvel aperçu, le
    // seul moment où l'on peut encore s'arrêter sans gaspiller. Le seuil
    // laisse 20 % au-dessus du pire cas légitime, bascule de modèle et
    // réparations comprises : une génération normale n'est jamais coupée.
    //
    // On ne jette rien : si un aperçu a déjà été produit, il est livré.
    if (depense.depasse) {
      console.warn(
        `[ia-pipeline] Site ${site._id} — plafond de dépense atteint ` +
          `($${depense.totalUsd.toFixed(3)} / $${depense.plafondUsd.toFixed(2)}), ` +
          `aperçu ${i} non lancé.`
      );
      signalerIncident({
        composant: 'generation-site',
        erreur:
          `Plafond de dépense atteint : $${depense.totalUsd.toFixed(3)} pour un plafond de ` +
          `$${depense.plafondUsd.toFixed(2)}. Répartition : ${JSON.stringify(depense.repartition())}. ` +
          `Un fournisseur consomme anormalement — à vérifier avant que cela ne se répète.`,
        contexte: `plafond-depense:${site.niche}`,
        gravite: 'critique',
        categorie: 'serieuse',
      }).catch(() => {});
      return null;
    }

    // Le suffixe "retry" garantit un seed distinct de la tentative
    // précédente, même à quelques millisecondes d'intervalle.
    const seedDa = forceVariation
      ? `seed_${site.niche}_${i}_retry_${Date.now()}`
      : `seed_${site.niche}_${i}_${Date.now()}`;

    // Consigne de rupture, ajoutée uniquement en relance : sans elle, le
    // Codeur reproduirait naturellement une mise en page très proche.
    const validatedCopy = (site.brief as { validatedCopy?: string }).validatedCopy;
    const consigneTextes = validatedCopy
      ? ` TEXTES VALIDÉS PAR LE CLIENT — utilise-les tels quels (tu peux seulement adapter la découpe) :\n${String(validatedCopy).slice(0, 4000)}`
      : i === 2
        ? ' TEXTES : MÊME message, mêmes informations, mêmes offres et mêmes prix que le premier aperçu (tout vient du brief) — seule la FORMULATION change : angle preuve et concret plutôt que désir et aspiration, titres reformulés. Ne change jamais le sens, n\'ajoute aucune promesse.'
        : ' TEXTES : clairs, concrets, orientés bénéfice immédiat, fidèles au brief.';
    const consigneStructure =
      i === 2
        ? ' STRUCTURE DISTINCTE : autre type de hero, autre ordre des sections, autre densité. Palette et composants de CETTE librairie uniquement.'
        : ' STRUCTURE : hero fort, sections aérées, mobile d’abord.';
    const consigneVariation = forceVariation
      ? ` IMPORTANT — cette génération REMPLACE une version jugée insuffisante : change franchement de direction artistique (palette au sein de la niche, rythme des sections, choix et ordre des composants, style de mise en page). Ne reproduis pas la structure précédente.`
      : '';

    const userInstruction =
      previewCount === 1
        ? `Génère le site du client. Seed Direction Artistique : ${seedDa}.${consigneStructure}${consigneTextes}${consigneVariation}`
        : `Génère une direction ${i === 1 ? 'A' : 'B'} pour le site du client. Seed : ${seedDa}.${consigneStructure}${consigneTextes}${consigneVariation}`;

    // Répartition :
    //   · Premium            → codeur_premium (Opus 5.5, alternable Fable 5.1)
    //   · Standard aperçu 2  → codeur_normale_apercu2 (Sonnet 5)
    //   · Essai / aperçu 1   → codeur_normale (Grok 4.7 ou Sonnet 5, admin)
    const roleCodeur = isPremium
      ? 'codeur_premium'
      : i === 2
        ? 'codeur_normale_apercu2'
        : 'codeur_normale';
    const modeleCodeur = await getModelForRole(roleCodeur);
    modeleCodeurParApercu[i] = modeleCodeur;
    let html = await appelerCodeur(modeleCodeur, systemPrompt, userInstruction, {
      maxTokens: 16000,
      temperature: 0.5 + i * 0.05,
      cleCache: cleCacheGrok('codeur', ctx),
    });

    // Nettoyage éventuel de fences markdown
    html = html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

    // ─────────────────────────────────────────────────────────────
    // SCAN 1 — contrôle syntaxique SANS IA (~0$), avant le Juge Code.
    // Un scan n'est PAS un juge : il évite de payer un appel IA pour
    // juger du HTML manifestement cassé. Tourne dans tous les cas,
    // essai gratuit compris (Architecture v6, section 4).
    // ─────────────────────────────────────────────────────────────
    const scan1 = runScan1(html);
    if (!scan1.ok) {
      console.warn(
        `[ia-pipeline] Scan 1 a détecté ${scan1.issues.length} problème(s) sur l'aperçu ${i} :\n${formatScanIssues(scan1)}`
      );

      if (isLikelyTruncated(scan1)) {
        // Troncature max_tokens : 1 seul tour "continue" Codeur (pas le Réparateur).
        console.warn(`[ia-pipeline] Troncature détectée sur aperçu ${i} — 1 continue Codeur`);
        try {
          const continueInstruction =
            'Ta réponse précédente a été COUPÉE (HTML incomplet, sans </html> ou balises non fermées). ' +
            'Reprends et produis le HTML COMPLET et autonome de A à Z, en terminant obligatoirement par </html>. ' +
            'Aucun markdown, aucune excuse. Voici le fragment tronqué à compléter / reconstruire :\n\n' +
            html.slice(0, 12000);

          const continued = await appelerCodeur(modeleCodeur, systemPrompt, continueInstruction, {
            maxTokens: 16000,
            temperature: 0.3,
            cleCache: cleCacheGrok('codeur', ctx),
          });
          html = continued.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
        } catch (contErr) {
          console.warn('[ia-pipeline] Continue Codeur échoué — bascule Réparateur', contErr);
          const preRepairRaw = await callGrok(
            'grok-build-0.1',
            [
              { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
              { role: 'user', content: buildRepairPrompt(html, formatScanIssues(scan1)) },
            ],
            { maxTokens: 16000, temperature: 0.2 }
          );
          const preRepair = parseJsonSafe<{ html_patch: string }>(preRepairRaw);
          if (preRepair?.html_patch) {
            html = preRepair.html_patch.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
          }
        }
      } else {
        // HTML mal formé mais pas tronqué → Réparateur classique
        const preRepairRaw = await callGrok(
          'grok-build-0.1',
          [
            { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
            { role: 'user', content: buildRepairPrompt(html, formatScanIssues(scan1)) },
          ],
          { maxTokens: 16000, temperature: 0.2 }
        );
        const preRepair = parseJsonSafe<{ html_patch: string }>(preRepairRaw);
        if (preRepair?.html_patch) {
          html = preRepair.html_patch.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
        }
      }
    }

    // 2. Juge Code — modèle réglé dans Équipe IA. Il juge avec les règles de
    //    la Librairie (bloc commun + JUDGES.md) : décision en 2 temps,
    //    VETO puis note /100 (voir JUDGES.md).
    const modeleJugeCode = await getModelForRole('juge_code');

    // Score par défaut bas si le juge ne répond pas en JSON valide (plus de faux 80 silencieux)
    let score = 55;
    let judge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2500 });

    if (!judge) {
      // Retry juge UNIQUEMENT plans payants (éviter coût API inutile sur l'essai gratuit)
      if (plan !== 'trial' && plan !== 'starter') {
        console.warn(`[ia-pipeline] Juge Code JSON invalide aperçu ${i} — 1 retry (payant).`);
        try {
          judge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2500, strict: true });
        } catch (jErr) {
          console.warn('[ia-pipeline] Retry Juge Code échoué', jErr);
        }
      } else {
        console.warn(
          `[ia-pipeline] Juge Code JSON invalide aperçu ${i} (essai) — pas de retry pour limiter le coût. score défaut 55.`
        );
      }
    }

    // Vetos du juge code encore présents sur la page (mis à jour après réparation).
    let vetosCode: string[] = vetosDe(judge);

    if (judge) {
      score = typeof judge.score_total === 'number' ? judge.score_total : 55;

      // 3. Réparation si au moins un veto, un bloquant, ou une note < 80
      if (score < 80 || vetosCode.length > 0 || (judge.bloquants && judge.bloquants.length > 0)) {
        const repairRaw = await callGrok(
          'grok-build-0.1',
          [
            { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
            {
              role: 'user',
              content: buildRepairPrompt(
                html,
                JSON.stringify({ vetos: vetosCode, erreurs: judge.erreurs ?? [] })
              ),
            },
          ],
          { maxTokens: 16000, temperature: 0.2 }
        );

        const repair = parseJsonSafe<{ html_patch: string }>(repairRaw);
        if (repair?.html_patch) {
          html = repair.html_patch.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

          // ─────────────────────────────────────────────────────────
          // SCAN 2 — vérifie que la réparation est syntaxiquement propre
          // AVANT de repayer un appel de jugement dessus (sans IA, ~0$).
          // ─────────────────────────────────────────────────────────
          const scan2 = runScan2(html);
          if (!scan2.ok) {
            console.warn(
              `[ia-pipeline] Scan 2 : la réparation a laissé ${scan2.issues.length} problème(s) sur l'aperçu ${i} :\n${formatScanIssues(scan2)}`
            );
            // 2e et DERNIER tour de réparation (2 tours max au total —
            // Architecture v6 : jamais 3, ni en essai ni en payant).
            const repair2Raw = await callGrok(
              'grok-build-0.1',
              [
                { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
                { role: 'user', content: buildRepairPrompt(html, formatScanIssues(scan2)) },
              ],
              { maxTokens: 16000, temperature: 0.2 }
            );
            const repair2 = parseJsonSafe<{ html_patch: string }>(repair2Raw);
            if (repair2?.html_patch) {
              html = repair2.html_patch.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
            }
          }

          // Re-jugement après réparation — même juge que ci-dessus (réglage
          // Équipe IA). Avant, « grok-4.5 » était écrit en dur ici.
          const rejudge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2000 });
          if (rejudge?.score_total != null) {
            score = rejudge.score_total;
            vetosCode = vetosDe(rejudge);
            judge = { ...judge, ...rejudge };
          }
        }
      }
    }

    // 4. Juge Visuel — Opus 5.5 par défaut, Sonnet 5 quand Opus a codé.
    //    Un modèle ne juge jamais sa propre production (voir
    //    getJugeVisuelPour). Il juge avec les MÊMES règles que le codeur
    //    (Librairie : tests V1–V10 et barème visuel de JUDGES.md) et doit
    //    MOTIVER son verdict (raisons + conseils), réutilisé ensuite par la
    //    correction et par la file d'alertes admin.
    let judgeReasons: string[] = [];
    let judgeAdvice: string[] = [];
    let vetosVisuels: string[] = [];
    try {
      const modeleJugeVisuel = await getJugeVisuelPour(modeleCodeurParApercu[i]);
      const consigneJuge = systemeJugeVisuel(ctx);

      // Le juge analyse le RENDU RÉEL : captures sur téléphone (390 px) et
      // sur ordinateur (1 280 px). Si la capture échoue, repli sur l'analyse
      // du code : un jugement dégradé vaut mieux qu'une génération bloquée.
      const captures = await captureHtmlScreenshots(html);
      const visualRaw =
        captures.length > 0
          ? await callClaudeVisionBase64(
              modeleJugeVisuel as ClaudeModel,
              consigneJuge,
              `${ctx.blocNiche.texteFiche}\n\nNiche : ${site.niche}\nScore du code : ${score}\n` +
                `Voici le site rendu, d'abord sur téléphone (390 px), puis sur ordinateur (1 280 px). ` +
                `Juge ce que verra réellement un visiteur, avec les tests V1–V10 de la Librairie, ` +
                `et SURTOUT le comportement sur téléphone (V9, M3).`,
              captures.map(({ base64, mediaType }) => ({ base64, mediaType })),
              // 2 aperçus = 2 jugements par le même modèle, quelques secondes
              // d'écart : la consigne mise en cache au 1er est relue au 2e.
              { maxTokens: 1500, temperature: 0.2, reutilisationPrevue: previewCount > 1 }
            )
          : await callClaude(
              modeleJugeVisuel as ClaudeModel,
              consigneJuge,
              [
                {
                  role: 'user',
                  content:
                    `${ctx.blocNiche.texteFiche}\n\nNiche: ${site.niche}\nScore code actuel: ${score}\n` +
                    `Capture indisponible : juge d'après le code (début de la page) :\n${html.slice(0, 8000)}`,
                },
              ],
              { maxTokens: 1500, temperature: 0.2 }
            );
      const visual = parseJsonSafe<{
        score_visuel: number;
        ok: boolean;
        vetos?: string[];
        raisons?: string[];
        conseils?: string[];
      }>(visualRaw);
      if (visual?.score_visuel != null) {
        // Moyenne pondérée simple
        score = Math.round(score * 0.6 + visual.score_visuel * 0.4);
      }
      vetosVisuels = vetosDe(visual);
      if (Array.isArray(visual?.raisons)) judgeReasons = visual.raisons.slice(0, 5);
      if (Array.isArray(visual?.conseils)) judgeAdvice = visual.conseils.slice(0, 5);
    } catch (err) {
      console.warn('[ia-pipeline] Juge Visuel indisponible', err);
    }

    // Décision en 2 temps (JUDGES.md) : une page qui garde un veto voit sa
    // note plafonnée à 59 — elle déclenche donc l'IA Aide (plans payants)
    // et ne peut pas passer pour une bonne page dans le rapport qualité.
    const vetosRestants = () => Array.from(new Set([...vetosCode, ...vetosVisuels]));
    if (vetosRestants().length > 0) {
      score = Math.min(score, 59);
    }

    // ── 5. IA Aide — recours en reconstruction ──
    //
    // Déclenchée quand le score final reste sous 70, sur les plans payants
    // uniquement. Trois corrections par rapport à la version précédente :
    //
    //  · Elle reçoit TOUS LES VERDICTS et la PAGE ENTIÈRE. Avant, elle ne
    //    recevait qu'un score chiffré et les 10 000 premiers caractères
    //    d'une page qui en fait souvent 50 000 : on lui demandait de
    //    réparer sans lui dire ce qui n'allait pas, et sans lui montrer la
    //    majorité de la page.
    //
    //  · Son résultat est RE-JUGÉ. Avant, le score était forcé à 72 — donc
    //    au-dessus du seuil — et la page partait chez le client sans que
    //    personne n'ait relu ce qu'Opus venait d'écrire. Or sa réponse peut
    //    être coupée comme celle du codeur.
    //
    //  · Le modèle vient du panneau « Équipe IA ». Il était écrit en dur :
    //    changer le réglage n'avait aucun effet.
    //
    // Si le score reste faible après tout cela, le site est LIVRÉ TEL QUEL
    // avec une alerte pour l'administrateur. Une génération de plus, par un
    // quatrième modèle, coûterait 0,92 $ pour un résultat presque toujours
    // identique.
    if (score < 70 && plan !== 'trial' && plan !== 'starter' && !depense.depasse) {
      try {
        const modeleAide = await getModelForRole('aide_ia_payant');

        // Verdicts RÉELS des deux juges. C'est le cœur de la correction :
        // avant, l'IA Aide ne recevait qu'un score chiffré et devait deviner
        // ce qui n'allait pas.
        const verdicts = [
          vetosRestants().length
            ? `VETOS à corriger en priorité (numéros de règles de la Librairie) : ${vetosRestants().join(', ')}`
            : null,
          judge?.bloquants?.length
            ? `Juge Code — problèmes BLOQUANTS :\n- ${judge.bloquants.join('\n- ')}`
            : null,
          judge?.erreurs?.length
            ? `Juge Code — erreurs relevées :\n- ${judge.erreurs
                .map((e) => Object.values(e).join(' : '))
                .join('\n- ')}`
            : null,
          judgeReasons.length
            ? `Juge Visuel — ce qui ne va pas :\n- ${judgeReasons.join('\n- ')}`
            : null,
          judgeAdvice.length
            ? `Juge Visuel — conseils :\n- ${judgeAdvice.join('\n- ')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n');

        // Même Librairie que le codeur et les juges : l'IA Aide corrige
        // avec les règles exactes qui ont servi à juger la page.
        const aideHtml = await appelerCodeur(
          modeleAide,
          [
            { texte: ctx.blocCommun, cache: true },
            { texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texte}`, cache: true },
            {
              texte:
                "Tu es l'IA Aide NexAI. Une page a été jugée insuffisante. Corrige EXACTEMENT les " +
                'problèmes listés (numéros de règles de la Librairie ci-dessus), vetos d\'abord, en ' +
                'conservant tout ce qui fonctionne : structure, contenu, identité visuelle. Ne repars ' +
                'de zéro que si la page est irrécupérable. Réponds uniquement avec le HTML complet, ' +
                'sans commentaire.\n\n' +
                consigneLangue(langueClient),
            },
          ],
          `Niche : ${site.niche}\n${ligneClientele(site.brief)}\nBrief du client : ${JSON.stringify(site.brief)}\n\n` +
            `${verdicts || 'Aucun verdict détaillé disponible.'}\n\n` +
            `PAGE ACTUELLE (complète) :\n${html}`,
          { maxTokens: 16000, temperature: 0.3, cleCache: cleCacheGrok('aide', ctx) }
        );

        const htmlAide = aideHtml.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

        // Contrôle local : une page coupée ou cassée ne doit jamais
        // remplacer l'originale, même si elle vient d'un modèle avancé.
        const scanAide = runScan1(htmlAide);
        if (scanAide.ok) {
          html = htmlAide;
          // Re-jugement RÉEL de ce qu'Opus vient de produire. Le score n'est
          // plus jamais forcé : il est mesuré.
          // Le juge visuel n'est pas relancé (coût) : ses vetos sont
          // considérés comme traités par l'IA Aide, qui les a reçus.
          try {
            const jugeApres = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, { maxTokens: 2000 });
            if (typeof jugeApres?.score_total === 'number') {
              score = jugeApres.score_total;
              vetosCode = vetosDe(jugeApres);
              vetosVisuels = [];
              if (vetosCode.length > 0) score = Math.min(score, 59);
            }
          } catch (err) {
            console.warn('[ia-pipeline] Re-jugement après IA Aide indisponible', err);
          }
        } else {
          console.warn(
            `[ia-pipeline] IA Aide a produit une page invalide :\n${formatScanIssues(scanAide)}\n— original conservé`
          );
        }
      } catch (err) {
        console.warn('[ia-pipeline] IA Aide indisponible', err);
      }
    }

    // Score toujours faible : le site est livré tel quel, et l'administrateur
    // est informé. Avec le contrôle de clarté en amont, c'est le signe d'un
    // problème à examiner, pas d'une demande floue.
    if (score < 60) {
      signalerIncident({
        composant: 'generation-site',
        erreur:
          `Site livré avec un score faible (${score}) malgré l'IA Aide. Niche ${site.niche}. ` +
          `À examiner : demande du client, verdicts des juges, page produite.`,
        contexte: `score-faible:${site.niche}`,
        gravite: 'moyenne',
        categorie: 'serieuse',
      }).catch(() => undefined);
    }

    return {
      versionId: `prop_${i}`,
      seedDa,
      score,
      vetos: vetosRestants(),
      judgeReasons,
      judgeAdvice,
      htmlDemo: html,
      pagesMeta: [
        {
          slug: 'index',
          title: `Accueil — ${site.niche}`,
          description: String((site.brief as { description?: string }).description || ''),
        },
      ],
      dataNexaiIds: extractDataNexaiIds(html),
    };
  };

  const resultats = await Promise.allSettled(
    Array.from({ length: previewCount }, (_, idx) => runOnePreview(idx + 1))
  );
  for (const r of resultats) {
    if (r.status === 'fulfilled' && r.value) proposals.push(r.value);
    else if (r.status === 'rejected') {
      console.warn('[ia-pipeline] Aperçu non livré', r.reason);
    }
  }
  if (proposals.length === 0) {
    throw new Error('Aucun aperçu n’a pu être produit pour cette commande.');
  }


  // Filtre qualité d'abord : garde les aperçus au-dessus du seuil (1 en
  // essai, jusqu'à 2 en payant — voir previewCount plus haut)
  let kept = proposals.filter((p) => (p.score ?? 0) >= PROPOSAL_MIN_SCORE);
  if (kept.length === 0 && proposals.length > 0) {
    kept = [...proposals].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 1);
  }
  kept = kept.map((p, idx) => ({
    ...p,
    versionId: `prop_${idx + 1}`,
    // Badge "Premium" : toutes les propositions du lot si qualité Premium choisie
    premiumBadge: isPremium,
  }));

  // Badge "Recommandé" : la proposition la mieux classée du lot (meilleur
  // score) — concept indépendant du badge Premium (voir ISiteProposal).
  // Peut donc coexister avec premiumBadge sur la même proposition : le client
  // ne valide qu'un seul lot par clic, aucune confusion possible entre les deux.
  if (kept.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      if ((kept[i].score ?? 0) > (kept[bestIdx].score ?? 0)) bestIdx = i;
    }
    kept[bestIdx].recommandeBadge = true;
  }

  // ── Images d'ambiance sur les aperçus conservés ──
  // Essai gratuit : un seul traitement, le client prend ce qui est produit.
  //         toujours Grok Imagine (photo réaliste + logo si disponible), pas de choix mockup/réaliste en essai.
  // Payant (créateur/agence/pro_max) : 2 aperçus (voir previewCount), dont le
  // premier en photo réaliste Grok Imagine avec logo intégré,
  //         et les autres en images "mockup" sourcées par Claude Sonnet 5 via
  //         Pexels (licence commerciale libre). Grok Imagine est le seul
  //         moteur des photos réalistes avec logo intégré.
  try {
    const brief = {
      niche: site.niche,
      brandName: String((site.brief as { brandName?: string }).brandName || ''),
      description: String((site.brief as { description?: string }).description || ''),
      tone: String((site.brief as { tone?: string }).tone || ''),
    };
    const logoUrl = site.chosenLogoUrl || site.logoProposals?.[0]?.url;

    if (plan === 'trial') {
      try {
        const prompt = buildSiteImagePrompt(brief);
        // Essai gratuit : palier standard (~0,02 $) — le coût d'acquisition
        // doit rester bas, l'essai n'est pas facturé.
        const img = await generateGrokImagine({
          prompt,
          aspectRatio: '16:9',
          imageUrl: logoUrl,
          tier: 'standard',
        });
        // Contrôle : le client ne doit jamais voir une image cassée — au
        // pire, le site part sans image d'ambiance plutôt qu'avec un lien mort.
        if (kept[0] && (await verifyImageUrl(img.url))) {
          kept[0].htmlDemo = injectHeroImage(kept[0].htmlDemo || '', img.url);
          kept[0].ambianceImages = [img.url];
          kept[0].imageStyle = 'realiste';
        } else {
          console.warn('[ia-pipeline] Image Grok Imagine invalide (essai) — site livré sans image');
        }
      } catch (err) {
        console.warn('[ia-pipeline] Image ambiance (essai) non générée', err);
      }
    } else if (plan === 'createur' || plan === 'agence' || plan === 'pro_max') {
      for (let i = 0; i < kept.length; i++) {
        // Chaque aperçu est traité indépendamment : un échec (génération OU
        // vérification) sur l'un ne doit jamais faire sauter les autres.
        try {
          if (i === 0) {
            // Premier aperçu (index 0) = photo réaliste Grok Imagine avec logo
            // intégré. Palier 2.0 (~0,04 $) : meilleure fidélité d'édition du
            // logo, réservé aux plans payants.
            const prompt = buildSiteImagePrompt(brief);
            const img = await generateGrokImagine({
              prompt,
              aspectRatio: '16:9',
              imageUrl: logoUrl,
              tier: 'v2',
            });
            if (await verifyImageUrl(img.url)) {
              kept[i].htmlDemo = injectHeroImage(kept[i].htmlDemo || '', img.url);
              kept[i].ambianceImages = [img.url];
              kept[i].imageStyle = 'realiste';
            } else {
              console.warn(`[ia-pipeline] Image Grok Imagine invalide (aperçu ${i}) — livré sans image`);
            }
          } else {
            // L'autre aperçu = mockup propre sourcé par Claude Sonnet 5 (Pexels) —
            // sourceMockupImage vérifie déjà la validité de l'image en interne.
            const img = await sourceMockupImage({
              ...brief,
              sectionHint: 'hero',
              orientation: 'landscape',
            });
            kept[i].htmlDemo = injectHeroImage(kept[i].htmlDemo || '', img.url);
            kept[i].ambianceImages = [img.url];
            kept[i].imageStyle = 'mockup';
            kept[i].imageAttribution = img.sourceAttribution;
          }
        } catch (err) {
          console.warn(`[ia-pipeline] Image ambiance non générée (aperçu ${i}) — livré sans image`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[ia-pipeline] Images ambiance non générées', err);
  }

  // ── Pages secondaires (sites multi-pages selon niche/brief) ──
  // N'affecte que les niches qui en ont besoin (voir PAGES_PAR_NICHE) — pour
  // toutes les autres, kept[].pages reste vide et le site garde son
  // comportement historique de page unique (htmlDemo).
  //
  // Plusieurs aperçus (Standard) : les pages restantes ne sont créées que
  // pour l'aperçu que le client CHOISIT (« Finaliser mon site », voir
  // enqueueFinalisation) — les fabriquer pour les deux doublait le coût
  // pour un aperçu abandonné. Un seul aperçu (essai, Premium) : pages
  // créées tout de suite, le site est livré complet.
  try {
    if (pagePlan.length > 1) {
      if (kept.length > 1) {
        for (const p of kept) p.pagesStatut = 'a_finaliser';
      } else if (!depense.depasse) {
        for (const p of kept) {
          if (depense.depasse) break;
          await generateSecondaryPagesForProposal(p, pagePlan, site, ctx, isPremium);
          p.pagesStatut = p.pages && p.pages.length > 0 ? 'pretes' : 'echec';
        }
      }
    }
  } catch (err) {
    console.warn('[ia-pipeline] Pages secondaires non générées', err);
  }

  site.proposals = kept;

  // ─────────────────────────────────────────────────────────────
  // Décision finale — Architecture v6, section 18.
  //
  // ESSAI GRATUIT : le site est TOUJOURS livré (règle « jamais 0 aperçu »),
  //   même sous le seuil. L'alerte créée est purement informative : elle
  //   sert à repérer qu'une niche produit du mauvais résultat en série.
  //
  // PAYANT : le site n'est PAS livré tant que l'admin (ou Fable) n'a pas
  //   tranché — Valider (livrer tel quel) ou Refuser (relancer depuis le
  //   Codeur). Le client a payé : on ne lui envoie pas un résultat raté
  //   sans arbitrage humain.
  // ─────────────────────────────────────────────────────────────
  const bestScore = kept.reduce((m, p) => Math.max(m, p.score ?? 0), 0);
  const sousSeuil = kept.length === 0 || bestScore < 60;
  const estEssai = plan === 'trial';

  if (sousSeuil) {
    // Le score est enregistré à titre informatif, jamais comme motif :
    // le vrai motif reste le verdict des juges (verdictJuges ci-dessous).
    const verdictJuges = kept.length
      ? kept
          .filter((p) => (p.score ?? 0) < 60)
          .slice(0, 2)
          .map((p) => ({
            juge: 'visuel' as const,
            verdict: 'FAIL' as const,
            raisons: p.judgeReasons ?? [],
            conseils: p.judgeAdvice ?? [],
          }))
      : [];

    // Échec APRÈS la refabrication de Fable : c'était la première et la
    // Fable ne refabrique PLUS les sites.
    //
    // Il arrivait en troisième tentative, après le codeur et après l'IA Aide.
    // Or l'IA Aide reçoit désormais tous les verdicts et la page entière :
    // une quatrième main sur le même site n'apporte presque rien, et coûtait
    // 0,92 $ — soit 37 points de marge sur un site difficile.
    //
    // Le site est donc LIVRÉ TEL QUEL, et l'alerte sert d'historique pour
    // l'administrateur. Elle est close dès sa création : plus aucune file
    // d'attente, plus aucune génération supplémentaire.
    //
    // Fable conserve ses autres rôles : diagnostic des incidents de
    // plateforme, diagnostic des prompts, amélioration à la demande.
    try {
      await AlerteQualite.create({
        siteId: site._id,
        userId: site.userId,
        type: 'information',
        statut: 'traitee_auto',
        niche: site.niche,
        plan,
        verdictJuges,
        score: bestScore || undefined,
        traitePar: 'systeme',
        traiteA: new Date(),
      });
    } catch (err) {
      // Ne bloque jamais la livraison pour un échec d'alerte.
      console.error('[ia-pipeline] Création alerte qualité échouée :', err);
    }


    await logEvent({
      categorie: 'alerte_qualite',
      niveau: estEssai ? 'info' : 'warn',
      message: estEssai
        ? `Essai — site livré sous le seuil (niche ${site.niche})`
        : `Payant — site en attente de décision admin (niche ${site.niche})`,
      siteId: site._id,
      userId: site.userId,
      contexte: { score: bestScore, propositions: kept.length },
    });

    // Le site est TOUJOURS livré, quel que soit le plan.
    //
    // Plus aucune mise en attente : Fable ne refabrique plus, il n'y a donc
    // plus rien à attendre. Un site un peu faible mais exploitable vaut
    // mieux qu'un client qui patiente pour un résultat presque identique —
    // et il peut le modifier lui-même, gratuitement.
    site.coutGenerationUsd = Number(depense.totalUsd.toFixed(4));
    site.coutParModele = depense.repartition();
    site.status = 'ready';
    console.warn(
      `[ia-pipeline] Site ${siteId} sous seuil (score=${bestScore}, propositions=${kept.length}) → ${site.status}`
    );
  } else {
    site.status = 'ready';
  }
  site.lastError = undefined;
  await site.save();

  // Email « vos propositions sont prêtes » — la génération est asynchrone et
  // dure plusieurs minutes : beaucoup de clients ferment l'onglet entre-temps
  // (Architecture v6, section 4). Jamais bloquant.
  if (site.status === 'ready') {
    try {
      const proprietaire = owner ?? (await User.findById(site.userId).select('email'));
      if (proprietaire?.email) {
        await sendGenerationReadyEmail({
          to: proprietaire.email,
          siteName: site.name,
          nbPropositions: kept.length,
          lienApercu: `${env.CLIENT_URL}/apercu/${site._id}`,
        });
      }
    } catch (err) {
      console.error('[ia-pipeline] Email de notification non envoyé (non bloquant) :', err);
    }
  }

  // Coût réel de la génération, enregistré pour le suivi de rentabilité.
  // Le compteur est libéré ensuite : une autre génération ne doit jamais
  // hériter du compte de celle-ci.
  try {
    await Site.findByIdAndUpdate(site._id, {
      coutGenerationUsd: Number(depense.totalUsd.toFixed(4)),
      coutParModele: depense.repartition(),
      depenseCumuleeUsd: Number(depense.totalUsd.toFixed(4)),
    });
    console.log(
      `[ia-pipeline] Site ${site._id} — coût réel $${depense.totalUsd.toFixed(3)} ` +
        `(plafond $${depense.plafondUsd.toFixed(2)})`
    );
  } finally {
    /* compteur isolé via AsyncLocalStorage — rien à nettoyer ici */
  }

  return kept;
}

function extractDataNexaiIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /data-nexai-id=["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]);
  return Array.from(ids);
}

/**
 * « Finaliser mon site » — le client a choisi son aperçu : on crée les pages
 * restantes (menu, contact…) pour CET aperçu seulement, jugées comme
 * l'accueil. Aucun débit supplémentaire : c'est la suite de la génération
 * déjà payée (ou de l'essai).
 */
export async function enqueueFinalisation(siteId: string, userId: string, versionId: string) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);
  if (site.status !== 'ready' && site.status !== 'launched') {
    throw new AppError("Le site n'est pas encore prêt : attendez la fin de la création.", 400);
  }
  const proposition = site.proposals.find((p) => p.versionId === versionId);
  if (!proposition) throw new AppError('Proposition introuvable', 400);

  site.chosenProposalId = versionId;
  // « En cours » depuis plus de 20 minutes = travail interrompu (redémarrage
  // du worker…) : on autorise une nouvelle tentative.
  const bloqueDepuis = Date.now() - new Date((site as { updatedAt?: Date }).updatedAt ?? Date.now()).getTime();
  const enCoursActif = proposition.pagesStatut === 'en_cours' && bloqueDepuis < 20 * 60 * 1000;
  if (proposition.pagesStatut === 'pretes' || enCoursActif || !proposition.pagesStatut) {
    // Déjà complète, déjà en cours, ou site d'une seule page : rien à créer.
    await site.save();
    return { site, lancee: false };
  }
  proposition.pagesStatut = 'en_cours';
  site.markModified('proposals');
  await site.save();

  await pipelineQueue.add(
    'finaliser_pages',
    { siteId, userId, type: 'finaliser_pages', versionId },
    { jobId: `fin_${siteId}_${versionId}_${Date.now()}`, attempts: 1, removeOnComplete: true, removeOnFail: 50 }
  );
  return { site, lancee: true };
}

/** Exécutée par le worker : pages restantes de l'aperçu choisi. */
export async function processFinalisation(siteId: string, versionId: string): Promise<void> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error(`Site ${siteId} introuvable`);
  const proposition = site.proposals.find((p) => p.versionId === versionId);
  if (!proposition) throw new Error(`Proposition ${versionId} introuvable`);

  const owner = await User.findById(site.userId);
  const plan = owner?.plan || 'trial';
  const isPremium = site.qualityTier === 'premium';
  const depense = new CompteurDepense(plan === 'trial' ? 'essai' : isPremium ? 'premium' : 'normale');
  depense.reprendre(site.depenseCumuleeUsd || 0);
  reinitialiserUsage();

  try {
    await avecCompteurDepense(depense, async () => {
      const ctx = await preparerContexteLibrairie(site.niche);
      const pagePlan = resolvePagePlan(site.niche, site.brief);
      await generateSecondaryPagesForProposal(proposition, pagePlan, site, ctx, isPremium);
    });
    proposition.pagesStatut = proposition.pages && proposition.pages.length > 0 ? 'pretes' : 'echec';
  } catch (err) {
    console.warn(`[ia-pipeline] Finalisation échouée site=${siteId}`, err);
    proposition.pagesStatut = 'echec';
  }
  site.depenseCumuleeUsd = Number(depense.totalUsd.toFixed(4));
  site.markModified('proposals');
  await site.save();
}

export async function chooseProposal(siteId: string, userId: string, versionId: string) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);
  // Le choix reste possible APRÈS la mise en ligne.
  //
  // Les deux propositions restent stockées : rien ne justifie d'enfermer le
  // client dans son premier choix. S'il préfère finalement l'autre, il la
  // sélectionne et remet son site en ligne — la remise en ligne reste
  // payante, mais la proposition ne lui est plus inaccessible.
  if (site.status !== 'ready' && site.status !== 'launched') {
    throw new AppError("Le site n'est pas encore prêt : attendez la fin de la création.", 400);
  }

  const found = site.proposals.find((p) => p.versionId === versionId);
  if (!found) throw new AppError('Proposition introuvable', 400);

  site.chosenProposalId = versionId;
  await site.save();
  return site;
}

/**
 * Trouve un slug de sous-domaine NexAI libre, en partant du slug souhaité
 * et en ajoutant -2, -3, … si déjà pris par un AUTRE site (peu importe le
 * client). On ne considère occupés que les sites encore actifs
 * (lancés ou en cours de relance) — un site abandonné ou en échec ne doit
 * pas bloquer un nom pour toujours.
 */
async function resolveUniqueSubdomainSlug(baseSlug: string, currentSiteId: string): Promise<string> {
  const base = baseSlug.slice(0, 40) || `site-${shortHash(currentSiteId, 10)}`;
  const MAX_ATTEMPTS = 30;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidateSlug = attempt === 0 ? base : `${base.slice(0, 37)}-${attempt + 1}`;
    const candidateDomain = `${candidateSlug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`;
    const conflict = await Site.exists({
      _id: { $ne: currentSiteId },
      domainName: candidateDomain,
      status: { $in: ['launched', 'generating'] },
    });
    if (!conflict) return candidateSlug;
  }
  // Filet de sécurité si 30 variantes numérotées sont toutes prises (cas
  // extrêmement improbable) : un suffixe unique garanti.
  return `${base.slice(0, 30)}-${shortHash(currentSiteId + Date.now(), 8)}`;
}

export async function enqueueLaunch(
  siteId: string,
  userId: string,
  opts: {
    domainType: 'sous_domaine' | 'godaddy' | 'byod';
    domainName?: string;
    /** Slug souhaité pour sous-domaine NexAI (ex: mon-resto) */
    subdomainSlug?: string;
    paymentMode: 'lien_personnel' | 'chariow';
    /** Lien de paiement pour CE site — sinon on reprend celui du compte (user.personalPaymentLink) */
    paymentLink?: string;
    /** Libellé du prestataire — affichage uniquement, sinon on reprend celui du compte */
    paymentProvider?: PaymentProvider;
  }
) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);
  if (!site.chosenProposalId) throw new AppError('Aucune proposition choisie', 400);
  {
    const choisie = site.proposals.find((p) => p.versionId === site.chosenProposalId);
    if (choisie?.pagesStatut === 'a_finaliser' || choisie?.pagesStatut === 'echec') {
      throw new AppError(
        'Finalisez d’abord votre site : cliquez sur « Finaliser mon site » pour créer les pages restantes.',
        400
      );
    }
    if (choisie?.pagesStatut === 'en_cours') {
      throw new AppError('Les pages restantes de votre site sont en cours de création : réessayez dans quelques minutes.', 400);
    }
  }

  // Anti double-commande — AVANT tout débit. C'est le cas le plus coûteux :
  // un double clic achetait potentiellement deux fois le domaine.
  await assertNoDuplicateJob(
    siteId,
    'redeploiement',
    'La mise en ligne de ce site est déjà en cours. Inutile de relancer, suivez la progression à l\'écran.'
  );

  const user = await User.findById(userId);
  if (!user || user.plan === 'trial') {
    throw new AppError('La mise en ligne est réservée aux abonnés. Passez à un abonnement pour continuer.', 403);
  }
  if (user.plan === 'starter') {
    throw new AppError("Le plan Starter est réservé à l'Académie. Passez à Créateur+ pour lancer un site.", 403);
  }

  // Résolution + validation du lien de paiement AVANT tout débit de crédits
  // (Partie D.9) — uniquement pour paymentMode='lien_personnel' : le mode
  // 'chariow' (compte NexAI + reversement) n'utilise pas de lien à valider.
  let resolvedPaymentLink: string | undefined;
  let resolvedPaymentProvider: PaymentProvider | undefined;
  if (opts.paymentMode === 'lien_personnel') {
    resolvedPaymentLink = (opts.paymentLink || user.personalPaymentLink || '').trim();
    resolvedPaymentProvider = opts.paymentProvider || user.personalPaymentProvider;
    if (!resolvedPaymentLink) {
      throw new AppError(
        'Indiquez votre lien de paiement (ou renseignez-le une fois pour toutes dans vos paramètres).',
        400
      );
    }
    // Bloque net le lancement si le lien est invalide/inactif, avant tout débit.
    await assertValidPaymentLink(resolvedPaymentLink);
  }

  // Normalisation slug sous-domaine
  let resolvedDomainName = opts.domainName?.trim().toLowerCase();
  let subdomainSlug = opts.subdomainSlug?.trim().toLowerCase();

  if (opts.domainType === 'sous_domaine') {
    const raw =
      subdomainSlug ||
      resolvedDomainName?.replace(
        new RegExp(`\\.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN.replace(/\./g, '\\.')}$`, 'i'),
        ''
      ) ||
      '';
    const cleaned = raw
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const baseSlug =
      cleaned ||
      `site-${shortHash(String(site._id) + String(userId), 10)}`;

    // Unicité : deux clients ne peuvent pas se retrouver sur le même
    // sous-domaine : Netlify refuserait le 2e custom_domain, et un échec
    // avalé en silence côté worker laisserait le client avec un site sans
    // sous-domaine, sans le savoir. On cherche donc ici le premier slug
    // libre, en ajoutant -2, -3, etc.
    subdomainSlug = await resolveUniqueSubdomainSlug(baseSlug, String(site._id));
    resolvedDomainName = `${subdomainSlug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`;
  } else if (opts.domainType === 'godaddy' || opts.domainType === 'byod') {
    if (!resolvedDomainName) {
      throw new AppError('Indiquez le nom de domaine souhaité.', 400);
    }
  }

  // GoDaddy : vérifier dispo + prix réel AVANT tout débit (évite de facturer
  // un domaine indisponible, et permet de facturer le prix exact + 5cr —
  // voir getDomainPriceCredits — plutôt qu'un forfait générique).
  let godaddyPriceUsd: number | null = null;
  if (opts.domainType === 'godaddy' && resolvedDomainName) {
    try {
      const { available, priceUsd } = await checkDomainAvailability(resolvedDomainName);
      if (!available) {
        throw new AppError(
          `Le nom de domaine « ${resolvedDomainName} » n'est pas disponible. Choisissez-en un autre ou utilisez un domaine que vous possédez déjà.`,
          409
        );
      }
      godaddyPriceUsd = priceUsd;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'Impossible de vérifier la disponibilité de ce domaine pour le moment. Réessayez dans un instant.',
        502
      );
    }
  }

  // Coût mise en ligne
  await debitCredits(userId, CREDIT_COSTS.METTRE_EN_LIGNE, 'generation_site', {
    relatedSiteId: siteId,
    action: 'METTRE_EN_LIGNE',
  });

  let domainResult = { chargedCredits: 0, usedQuota: false };
  try {
    domainResult = await resolveDomainCostAndConsume(userId, opts.domainType, {
      relatedSiteId: siteId,
      domainName: resolvedDomainName,
      priceUsd: godaddyPriceUsd,
    });
  } catch (err) {
    // Rembourse le lancement si le domaine échoue après le débit 15 crédits
    await refundLaunchCharges(
      userId,
      { launchCredits: CREDIT_COSTS.METTRE_EN_LIGNE, domainCredits: 0, usedDomainQuota: false },
      { relatedSiteId: siteId, reason: 'remboursement_domaine_echec' }
    );
    throw err;
  }

  const charges: LaunchCharges = {
    launchCredits: CREDIT_COSTS.METTRE_EN_LIGNE,
    domainCredits: domainResult.chargedCredits,
    usedDomainQuota: domainResult.usedQuota,
  };

  site.domainType = opts.domainType;
  site.domainName = resolvedDomainName;
  site.paymentMode = opts.paymentMode;
  site.paymentLink = resolvedPaymentLink;
  site.paymentProvider = resolvedPaymentProvider;
  await site.save();

  const jobPayload = {
    siteId,
    userId,
    type: 'launch_site' as const,
    domainType: opts.domainType,
    domainName: resolvedDomainName,
    subdomainSlug,
    paymentMode: opts.paymentMode,
    paymentLink: resolvedPaymentLink,
    paymentProvider: resolvedPaymentProvider,
    charges,
  };

  const bullJob = await pipelineQueue.add('launch_site', jobPayload, {
    jobId: `launch_${siteId}_${Date.now()}`,
  });

  await Job.create({
    type: 'redeploiement',
    siteId: site._id,
    status: 'queued',
    bullJobId: String(bullJob.id),
    meta: jobPayload,
  });

  return { jobId: bullJob.id, domainName: resolvedDomainName, charges };
}


/** Injecte une image hero dans le HTML démo (premier header/section ou body). */
function injectHeroImage(html: string, imageUrl: string): string {
  const style = `style="background-image:url('${imageUrl}');background-size:cover;background-position:center;"`;
  if (html.includes('id="page-accueil"')) {
    return html.replace(
      /id="page-accueil"([^>]*)>/,
      `id="page-accueil"$1 ${style}>`
    );
  }
  if (html.includes('<header')) {
    return html.replace(/<header([^>]*)>/, `<header$1 ${style}>`);
  }
  return html.replace(
    /<body([^>]*)>/,
    `<body$1><div data-nexai-id="hero-ambiance" ${style} class="nexai-hero-ambiance"></div>`
  );
}
