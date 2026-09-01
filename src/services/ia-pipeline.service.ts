import { Site, ISiteProposal, SiteNiche, SiteQualityTier } from '@/models/Site';
import { Job } from '@/models/Job';
import { User } from '@/models/User';
import { pipelineQueue } from '@/jobs/queue';
import {
  debitCredits,
  CREDIT_COSTS,
  PROPOSAL_MIN_SCORE,
  resolveDomainCostAndConsume,
  refundLaunchCharges,
  type LaunchCharges,
} from '@/services/credits.service';
import { callGrok, callClaude } from '@/services/ai-clients';
import { generateGrokImagine, buildSiteImagePrompt } from '@/services/grok-imagine.service';
import { sourceMockupImage } from '@/services/site-image-sourcing.service';
import { verifyImageUrl } from '@/utils/verifyMedia';
import { loadLibraryForNiche, libraryToCoderContext } from '@/services/library.service';
import { AppError } from '@/middleware/errorHandler';
import { checkDomainAvailability } from '@/services/godaddy.service';
import { shortHash } from '@/utils/zip';
import { assertValidPaymentLink } from '@/services/payment-link.service';
import { assertBusinessCompliant } from '@/services/content-compliance.service';
import type { PaymentProvider } from '@/models/Site';

/**
 * Pipeline IA RÉEL — conforme Source de Vérité Partie A.
 *
 * Rôles — qualité NORMALE (10 crédits) :
 * - Codeur      → Grok 4.6
 * - Juge Code   → Grok 4.5
 * - Réparateur  → Grok Build 0.1
 * - Juge Visuel → Claude Sonnet 5
 * - IA Aide     → Claude Opus 5 (payant uniquement, jamais essai/starter)
 *
 * Rôles — qualité PREMIUM (25 crédits, non disponible en essai) :
 * - Codeur      → Claude Sonnet 5
 * - Juge Code   → Grok 4.5 (inchangé)
 * - Réparateur  → Grok Build 0.1 (inchangé)
 * - Juge Visuel → Claude Opus 5
 * - IA Aide     → Claude Opus 5 (inchangé)
 *
 * Les deux scans (Scan 1 = Juge Code, Scan 2 = Juge Visuel) restent aux mêmes
 * étapes du pipeline dans les deux cas ; seuls les modèles derrière changent.
 *
 * Aucun mock. Les clés XAI_API_KEY et ANTHROPIC_API_KEY doivent être
 * renseignées sur Render (Environment).
 */

// ─── Bibliothèque minimale injectée au Codeur (par niche) ─
// En prod tu enrichiras depuis Mongo (design_systems, composants…).
// Ici : contrat minimal pour que le Codeur produise du HTML valide.

function buildCoderSystemPrompt(
  niche: SiteNiche,
  brief: Record<string, unknown>,
  libraryContext: string,
  isPremium: boolean,
  pagePlan?: { slug: string; title: string }[]
): string {
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI (Claude Sonnet 5), en mode qualité Premium.'
    : 'Tu es le Codeur NexAI (Grok 4.6).';
  const isMultiPage = !!pagePlan && pagePlan.length > 1;
  const multiPageInstructions = isMultiPage
    ? `\n\nCE SITE EST MULTI-PAGES. Plan de pages du site (à respecter dans le header ET le footer de CETTE page d'accueil) : ${pagePlan!
        .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
        .join(', ')}.\nPour chaque page AUTRE que l'accueil, utilise un vrai lien <a href="slug.html">Titre</a> vers son fichier (pas une simple ancre #) ; tu peux garder des ancres # uniquement pour naviguer DANS la page d'accueil elle-même.`
    : '';
  return `${identiteCodeur} Tu génères un site vitrine pro en HTML/CSS/JS autonome.


RÈGLES ABSOLUES :
- Un seul fichier HTML autonome (format démo) avec sections #page-accueil, #page-services, #page-contact
- Script JS minimal sans dépendance externe pour naviguer entre sections (hash)
- Tokens CSS uniquement (variables :root), WCAG 2.2 AA, un seul h1
- Attribut data-nexai-id unique sur chaque bloc de texte éditable
- Copywriting spécifique au brief (PAS/BAB), interdiction de formules vides
- Si (et SEULEMENT si) le brief indique que le client vend en ligne, prend des réservations payantes, des dons ou des abonnements : ajoute un bouton bien visible ("Payer", "Réserver", "Acheter"...) avec l'attribut data-nexai-payment-link sur la balise <a> (ex: <a data-nexai-payment-link href="#">Payer maintenant</a>). Ne mets JAMAIS de vraie URL de paiement — ce repère est résolu automatiquement après coup, une fois le lien réel du client connu.
- Niche : ${niche}
- Brief client (JSON) : ${JSON.stringify(brief)}${multiPageInstructions}

LIBRAIRIE SÉLECTIONNÉE (Mongo — respecter strictement palette, composants tirés, copy, anti-slop) :
${libraryContext}

Réponds UNIQUEMENT avec le HTML complet, sans markdown, sans explication.`;
}

function buildJudgeCodePrompt(html: string, niche: string): string {
  return `Tu es le Juge Code NexAI (Grok 4.5). Note ce HTML contre la grille NexAI.

Critères (total /100) :
- contraste_wcag (12, bloquant)
- responsive (18, bloquant)
- hierarchie_visuelle (12)
- distinctivite_anti_slop (10)
- espacement_coherent (8)
- alignement_grille (8)
- coherence_palette (8)
- typographie (6)
- sensation_pro (6)
- personnalite_niche (6)
- performance_percue (4)
- microinteractions_feedback (2)

Niche attendue : ${niche}

Réponds en JSON strict uniquement :
{"score_total": number, "bloquants": string[], "erreurs": [{"erreur_id":"err_001","composant":"...","data_nexai_id":"...","critere_viole":"...","gravite":"bloquant|majeur|mineur","constat":"...","correction_attendue":"..."}]}

HTML à juger :
${html.slice(0, 120000)}`;
}

function buildRepairPrompt(html: string, errorsJson: string): string {
  return `Tu es le Réparateur NexAI (Grok Build 0.1). Corrige UNIQUEMENT les erreurs signalées.
Déclare ta zone d'impact (data-nexai-id modifiés + tokens CSS changés).

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
const MIN_DESCRIPTION_LEN = 20; // doit ressembler à une vraie phrase, pas un mot isolé
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
    missing.push("une description de l'activité (au moins une phrase complète)");
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

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  // Starter = Académie uniquement — pas de génération de sites
  if (user.plan === 'starter') {
    throw new AppError('Le plan Starter est réservé à l\'Académie. Passez à Créateur pour générer des sites.', 403);
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

  // Débit selon la qualité choisie (10 crédits Normale / 25 crédits Premium ;
  // essai gratuit inclus uniquement pour la Normale ; admin = 0 dans tous les cas)
  const creditCost = qualityTier === 'premium' ? CREDIT_COSTS.GENERER_SITE_PREMIUM : CREDIT_COSTS.GENERER_SITE;
  const creditAction = qualityTier === 'premium' ? 'GENERER_SITE_PREMIUM' : 'GENERER_SITE';
  await debitCredits(userId, creditCost, 'apercu_site', {
    relatedSiteId: siteId,
    action: creditAction,
  });

  site.qualityTier = qualityTier;
  site.status = 'generating';
  await site.save();

  const bullJob = await pipelineQueue.add(
    'generation_site',
    { siteId, userId, type: 'generation_site' },
    { jobId: `gen_${siteId}_${Date.now()}` }
  );

  await Job.create({
    type: 'generation_site',
    siteId: site._id,
    status: 'queued',
    bullJobId: String(bullJob.id),
  });

  return { jobId: bullJob.id, status: 'queued' };
}

/**
 * Modification IA d'un site existant (coût 5 crédits).
 * Charge le site + brief + HTML choisi, applique l'instruction via le pipeline.
 */
export async function enqueueAiModify(siteId: string, userId: string, instruction: string) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);

  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  if (user.plan === 'starter') {
    throw new AppError("Le plan Starter est réservé à l'Académie. Passez à Créateur pour modifier un site.", 403);
  }
  if (user.plan === 'trial') {
    throw new AppError(
      'La modification IA est réservée aux abonnés. Passez à un abonnement pour continuer.',
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

  await debitCredits(userId, CREDIT_COSTS.MODIF_IA, 'modification_niveau2', {
    relatedSiteId: siteId,
    action: 'MODIF_IA',
    note: `ai-modify:${trimmed.slice(0, 80)}`,
  });

  site.status = 'generating';
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

  return { jobId: bullJob.id, status: 'queued' };
}

/**
 * Traitement worker : modification IA du HTML choisi (ou première proposition).
 */
export async function processAiModify(siteId: string, instruction: string): Promise<void> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error(`Site ${siteId} introuvable`);

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

  const systemPromptFor = (pageLabel: string) => `Tu es le Codeur NexAI. Tu modifies un site HTML existant selon l'instruction client.
RÈGLES :
- Conserve la structure, les data-nexai-id, et le design global sauf si l'instruction demande explicitement le contraire.
- Ce site peut compter plusieurs pages : applique l'instruction de façon cohérente avec le reste du site (même identité visuelle, même changement si l'instruction est globale — ex. couleur, ton, offre), et NE CASSE PAS les liens de navigation <a href="..."> déjà présents vers les autres pages.
- Un seul fichier HTML autonome en sortie, pour la page "${pageLabel}" uniquement.
- Brief client : ${JSON.stringify(site.brief)}
- Niche : ${site.niche}
Réponds UNIQUEMENT avec le HTML complet modifié de cette page, sans markdown.`;

  async function modifyPageHtml(pageHtml: string, pageLabel: string): Promise<string> {
    const raw = await callGrok(
      'grok-4.6',
      [
        { role: 'system', content: systemPromptFor(pageLabel) },
        {
          role: 'user',
          content: `Instruction de modification : ${instruction}\n\nHTML actuel :\n${pageHtml.slice(0, 100000)}`,
        },
      ],
      { maxTokens: 16000, temperature: 0.35 }
    );
    return raw.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  const idx = site.proposals.findIndex((p) => p.versionId === target!.versionId);
  if (idx < 0) throw new Error('Proposition introuvable pour ai-modify');

  // Page d'accueil — comportement historique, toujours modifiée.
  const newHome = await modifyPageHtml(target.htmlDemo!, 'Accueil');
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
  niche: SiteNiche,
  brief: Record<string, unknown>,
  libraryContext: string,
  isPremium: boolean,
  homepageHtml: string,
  page: { slug: string; title: string },
  allPages: { slug: string; title: string }[]
): string {
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI (Claude Sonnet 5), en mode qualité Premium.'
    : 'Tu es le Codeur NexAI (Grok 4.6).';
  const navLinks = allPages
    .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
    .join(', ');

  return `${identiteCodeur} Tu génères la page "${page.title}" (slug: ${page.slug}) d'un site multi-pages déjà commencé.

RÈGLE ABSOLUE DE COHÉRENCE : cette page fait partie du MÊME site que la page d'accueil ci-dessous. Réutilise exactement le même header/navigation, le même footer, la même palette de couleurs, la même typographie, les mêmes tokens CSS et le même contrat data-nexai-id que la page d'accueil. Ne change JAMAIS l'identité visuelle.

Navigation du site (toutes les pages, à inclure dans le header de CETTE page, avec des liens <a href="..."> vers chaque fichier) : ${navLinks}.

Niche : ${niche}. Brief client : ${JSON.stringify(brief)}.
Si (et SEULEMENT si) le brief indique une vente en ligne / réservation payante / don / abonnement ET que cette page est concernée : ajoute un bouton avec l'attribut data-nexai-payment-link sur la balise <a> (ex: <a data-nexai-payment-link href="#">Payer maintenant</a>), sans jamais mettre de vraie URL.

${libraryContext}

Page d'accueil du site (référence de style à reproduire strictement, ne PAS la recopier telle quelle — génère le contenu propre à "${page.title}") :
${homepageHtml.slice(0, 12000)}

Réponds uniquement avec le HTML complet et autonome de la page "${page.title}" (document HTML entier, <!DOCTYPE html> inclus).`;
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
  libraryContext: string,
  isPremium: boolean
): Promise<void> {
  const homepageHtml = proposal.htmlDemo || '';
  const secondaryPlan = pagePlan.filter((p) => p.slug !== 'index');
  if (secondaryPlan.length === 0 || !homepageHtml) return;

  const pages: NonNullable<ISiteProposal['pages']> = [];

  for (const page of secondaryPlan) {
    try {
      const prompt = buildSecondaryPageSystemPrompt(
        site.niche,
        site.brief,
        libraryContext,
        isPremium,
        homepageHtml,
        page,
        pagePlan
      );
      let html = isPremium
        ? await callClaude('claude-sonnet-5', prompt, [{ role: 'user', content: `Génère la page ${page.slug}.` }], {
            maxTokens: 16000,
            temperature: 0.4,
          })
        : await callGrok(
            'grok-4.6',
            [
              { role: 'system', content: prompt },
              { role: 'user', content: `Génère la page ${page.slug}.` },
            ],
            { maxTokens: 16000, temperature: 0.4 }
          );
      html = html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

      pages.push({ slug: page.slug, title: page.title, html });
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
 * Génération réelle des 3 propositions (appelé par le worker).
 */
export async function processGeneration(siteId: string): Promise<ISiteProposal[]> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error(`Site ${siteId} introuvable`);

  const owner = await User.findById(site.userId);
  const plan = owner?.plan || 'trial';
  const isPremium = site.qualityTier === 'premium';

  const lib = await loadLibraryForNiche(site.niche);
  const libraryContext = libraryToCoderContext(lib);
  // Calculé avant la génération de l'accueil pour que son header/footer
  // pointe déjà vers les bonnes pages (voir PAGES_PAR_NICHE / resolvePagePlan).
  const pagePlan = resolvePagePlan(site.niche, site.brief);
  const systemPrompt = buildCoderSystemPrompt(site.niche, site.brief, libraryContext, isPremium, pagePlan);
  const proposals: ISiteProposal[] = [];

  for (let i = 1; i <= 3; i++) {
    const seedDa = `seed_${site.niche}_${i}_${Date.now()}`;
    const userInstruction = `Génère la proposition ${i}/3. Seed Direction Artistique : ${seedDa}. Variante visuelle distincte des autres.`;

    // 1. Codeur — Claude Sonnet 5 en Premium, Grok 4.6 en Normale
    let html = isPremium
      ? await callClaude('claude-sonnet-5', systemPrompt, [{ role: 'user', content: userInstruction }], {
          maxTokens: 16000,
          temperature: 0.5 + i * 0.05,
        })
      : await callGrok(
          'grok-4.6',
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userInstruction },
          ],
          { maxTokens: 16000, temperature: 0.5 + i * 0.05 }
        );

    // Nettoyage éventuel de fences markdown
    html = html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

    // 2. Juge Code Grok 4.5 (Scan 1 — identique dans les deux qualités)
    const judgeRaw = await callGrok(
      'grok-4.5',
      [
        { role: 'system', content: 'Tu réponds uniquement en JSON valide, sans texte autour.' },
        { role: 'user', content: buildJudgeCodePrompt(html, site.niche) },
      ],
      { maxTokens: 2000, temperature: 0.1 }
    );

    let score = 80;
    const judge = parseJsonSafe<{
      score_total: number;
      bloquants: string[];
      erreurs: Array<Record<string, string>>;
    }>(judgeRaw);

    if (judge) {
      score = judge.score_total ?? 80;

      // 3. Réparation si score < 80 ou bloquants
      if (score < 80 || (judge.bloquants && judge.bloquants.length > 0)) {
        const repairRaw = await callGrok(
          'grok-build-0.1',
          [
            { role: 'system', content: 'Tu réponds uniquement en JSON valide.' },
            {
              role: 'user',
              content: buildRepairPrompt(html, JSON.stringify(judge.erreurs ?? [])),
            },
          ],
          { maxTokens: 16000, temperature: 0.2 }
        );

        const repair = parseJsonSafe<{ html_patch: string }>(repairRaw);
        if (repair?.html_patch) {
          html = repair.html_patch.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

          // Re-juge après réparation (simplifié)
          const rejudgeRaw = await callGrok(
            'grok-4.5',
            [
              { role: 'system', content: 'JSON uniquement.' },
              { role: 'user', content: buildJudgeCodePrompt(html, site.niche) },
            ],
            { maxTokens: 1500, temperature: 0.1 }
          );
          const rejudge = parseJsonSafe<{ score_total: number }>(rejudgeRaw);
          if (rejudge?.score_total != null) score = rejudge.score_total;
        }
      }
    }

    // 4. Juge Visuel — Scan 2 (identique dans les deux qualités, seul le modèle change) :
    //    Claude Sonnet 5 en Normale, Claude Opus 5 en Premium
    //    (texte uniquement ici ; captures d'écran = étape suivante)
    try {
      const visualJudgeModel = isPremium ? 'claude-opus-5' : 'claude-sonnet-5';
      const visualRaw = await callClaude(
        visualJudgeModel,
        'Tu es le Juge Visuel NexAI. Évalue la qualité perçue et anti-slop. Réponds en JSON : {"score_visuel": number, "ok": boolean, "commentaires": string}',
        [
          {
            role: 'user',
            content: `Niche: ${site.niche}\nScore code actuel: ${score}\nExtrait HTML (début):\n${html.slice(0, 8000)}`,
          },
        ],
        { maxTokens: 1000, temperature: 0.2 }
      );
      const visual = parseJsonSafe<{ score_visuel: number; ok: boolean }>(visualRaw);
      if (visual?.score_visuel != null) {
        // Moyenne pondérée simple
        score = Math.round(score * 0.6 + visual.score_visuel * 0.4);
      }
    } catch (err) {
      console.warn('[ia-pipeline] Juge Visuel indisponible', err);
    }

        // 5. IA Aide (Opus) si score encore < 70 — UNIQUEMENT plans payants (jamais essai)
    // Si Opus échoue ou le score reste insuffisant → flag needsSupport pour pending_support
    let needsSupport = false;
    if (score < 70) {
      if (plan !== 'trial' && plan !== 'starter') {
        try {
          const aideHtml = await callClaude(
            'claude-opus-5',
            'Tu es l\'IA Aide NexAI. Reconstruis un HTML pro complet si nécessaire. Réponds uniquement avec le HTML final.',
            [
              {
                role: 'user',
                content: `Niche ${site.niche}. Score actuel ${score}. Brief: ${JSON.stringify(site.brief)}\nHTML actuel:\n${html.slice(0, 10000)}`,
              },
            ],
            { maxTokens: 16000, temperature: 0.3 }
          );
          html = aideHtml.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
          score = Math.max(score, 72);
        } catch (err) {
          console.warn('[ia-pipeline] IA Aide indisponible', err);
          needsSupport = true;
        }
      } else {
        // Essai / starter : pas d'Opus — score bas signalé
        needsSupport = score < 60;
      }
      if (score < 60) needsSupport = true;
    }

    proposals.push({
      versionId: `prop_${i}`,
      seedDa,
      score,
      htmlDemo: html,
      pagesMeta: [
        {
          slug: 'index',
          title: `Accueil — ${site.niche}`,
          description: String((site.brief as { description?: string }).description || ''),
        },
      ],
      dataNexaiIds: extractDataNexaiIds(html),
    });
  }


  // Filtre qualité d'abord : 1, 2 ou 3 aperçus selon scores
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
  // Trial : 1 seul traitement possible (1 ou 2 aperçus retenus selon le score) — le client prend ce qu'il a,
  //         toujours Grok Imagine (photo réaliste + logo si disponible), pas de choix mockup/réaliste en essai.
  // Payant (créateur/agence/pro_max) : jusqu'à 3 aperçus, avec 1 photo réaliste Grok Imagine + logo,
  //         et les autres en images "mockup" sourcées par Claude Sonnet 5 via Pexels (licence commerciale libre).
  //         Grok Imagine gère désormais SEUL les photos réalistes avec logo — Alexya ne sert plus qu'à la vidéo.
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
        const img = await generateGrokImagine({
          prompt,
          aspectRatio: '16:9',
          imageUrl: logoUrl,
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
            // 1 aperçu sur 3 (index 0) = photo réaliste Grok Imagine avec logo intégré
            const prompt = buildSiteImagePrompt(brief);
            const img = await generateGrokImagine({
              prompt,
              aspectRatio: '16:9',
              imageUrl: logoUrl,
            });
            if (await verifyImageUrl(img.url)) {
              kept[i].htmlDemo = injectHeroImage(kept[i].htmlDemo || '', img.url);
              kept[i].ambianceImages = [img.url];
              kept[i].imageStyle = 'realiste';
            } else {
              console.warn(`[ia-pipeline] Image Grok Imagine invalide (aperçu ${i}) — livré sans image`);
            }
          } else {
            // Les 2 autres = mockup propre sourcé par Claude Sonnet 5 (Pexels) —
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
  try {
    if (pagePlan.length > 1) {
      for (const p of kept) {
        await generateSecondaryPagesForProposal(p, pagePlan, site, libraryContext, isPremium);
      }
    }
  } catch (err) {
    console.warn('[ia-pipeline] Pages secondaires non générées', err);
  }

  site.proposals = kept;

  // Si aucune proposition correcte ou scores trop bas après Opus → alerte admin
  const bestScore = kept.reduce((m, p) => Math.max(m, p.score ?? 0), 0);
  if (kept.length === 0 || bestScore < 60) {
    site.status = 'pending_support';
    console.warn(
      `[ia-pipeline] Site ${siteId} → pending_support (bestScore=${bestScore}, proposals=${kept.length})`
    );
  } else {
    site.status = 'ready';
  }
  await site.save();

  return kept;
}

function extractDataNexaiIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /data-nexai-id=["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]);
  return Array.from(ids);
}

export async function chooseProposal(siteId: string, userId: string, versionId: string) {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);
  if (site.status !== 'ready') throw new AppError('Le site n\'est pas prêt pour le choix', 400);

  const found = site.proposals.find((p) => p.versionId === versionId);
  if (!found) throw new AppError('Proposition introuvable', 400);

  site.chosenProposalId = versionId;
  await site.save();
  return site;
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

  const user = await User.findById(userId);
  if (!user || user.plan === 'trial') {
    throw new AppError('La mise en ligne est réservée aux abonnés. Passez à un abonnement pour continuer.', 403);
  }
  if (user.plan === 'starter') {
    throw new AppError("Le plan Starter est réservé à l'Académie. Passez à Créateur pour lancer un site.", 403);
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
      resolvedDomainName?.replace(/\.nexai\.com$/i, '') ||
      '';
    const cleaned = raw
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    subdomainSlug =
      cleaned ||
      `site-${shortHash(String(site._id) + String(userId), 10)}`;
    resolvedDomainName = `${subdomainSlug}.nexai.com`;
  } else if (opts.domainType === 'godaddy' || opts.domainType === 'byod') {
    if (!resolvedDomainName) {
      throw new AppError('Indiquez le nom de domaine souhaité.', 400);
    }
  }

  // GoDaddy : vérifier dispo AVANT tout débit (évite de facturer un domaine indisponible)
  if (opts.domainType === 'godaddy' && resolvedDomainName) {
    try {
      const available = await checkDomainAvailability(resolvedDomainName);
      if (!available) {
        throw new AppError(
          `Le nom de domaine « ${resolvedDomainName} » n'est pas disponible. Choisissez-en un autre ou utilisez un domaine que vous possédez déjà.`,
          409
        );
      }
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
