import { SITE_ESSAI_DEJA_UTILISE } from '@/constants/textes-client';
import type { HydratedDocument } from 'mongoose';
import { CompteurDepense } from '@/services/cout-generation.service';
import { avecCompteurDepense, plafondDepasse } from '@/services/depense-context';
import { signalerIncident } from '@/services/platform-alert.service';
import { assertRelanceGratuiteAutorisee } from '@/services/site-relaunch.service';
import { verifierClarteBrief } from '@/services/clarte-brief.service';
import { exigerTelephoneVerifie } from '@/services/verification-telephone.service';
import { Site, ISite, ISiteProposal, SiteNiche, SiteQualityTier } from '@/models/Site';
import { Job } from '@/models/Job';
import { User, IUser } from '@/models/User';
import { pipelineQueue } from '@/jobs/queue';
import {
  debitCredits,
  assertTrialNotExpired,
  creditCredits,
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
  reinitialiserUsage,
} from '@/services/ai-clients';
import { captureHtmlScreenshots } from '@/services/site-capture.service';
import { getModelForRole, getJugeVisuelPour } from '@/services/ai-role-registry';
import {
  chargerLibrairie,
  construireBlocCommun,
  construireBlocFamille,
  construireBlocJuges,
  construireBlocJugeVisuel,
  construireBlocNiche,
  declarationHtml,
  familleDe,
  indexerRegles,
  planDePagesLibrairie,
  type BlocNiche,
  type CombinaisonSite,
  type LibrairieComplete,
} from '@/services/library.service';
import { avecKit, sansKit } from '@/services/kit.service';
import { reparerPage } from '@/services/reparateur.service';
import { extraireGabarit, assemblerPage, type GabaritSite } from '@/services/gabarit-pages.service';
import { choisirCombinaison, cleCombinaison } from '@/services/combinaison.service';
import {
  construirePhotosAutorisees,
  creditsPhotos,
  textePhotosAutorisees,
} from '@/services/photos-autorisees.service';
import { lignesCredit } from '@/services/site-photo-stock.service';
import { controlerRendu, imagesHorsListe, type ErreurMesuree, type ResultatControle } from '@/services/controle-rendu.service';
import type { IPhotoAutorisee } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';
import { assertNoDuplicateJob, DuplicateRequestError } from '@/utils/jobGuard';
import { redisConnection } from '@/config/redis';
import { consigneLangue, type Langue } from '@/constants/pays';
import { assertAiKeysConfigured } from '@/services/ai-clients';
import { checkDomainAvailability } from '@/services/registrar.service';
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
 * Un seul aperçu par commande (décision du 02/10/2026) et UN seul codeur par
 * site (décision du 03/10/2026) : le modèle lu au début de la génération code
 * l'accueil ET toutes les pages intérieures.
 * - Essai gratuit et Standard → codeur_normale (Grok 4.7 par défaut, Sonnet 5.5 en alternance)
 * - Premium                   → codeur_premium (Opus 5.5)
 * - Réparateur                → reparateur_code (Grok Build par défaut, Sonnet 5.5), corrections ciblées
 * - IA Aide (plans payants)   → aide_ia_payant, seulement si le score reste sous 70
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
  /** Librairie complète lue pour cette génération (familles, styles, allowlist). */
  lib: LibrairieComplete;
  blocCommun: string;
  blocJuges: string;
  /** Sous-ensemble visuel de la Librairie pour le juge visuel (moins cher). */
  blocJugeVisuel: string;
  blocNiche: BlocNiche;
  /** Numéro de règle → texte (M3, C1, V9…) : sert à compléter les solutions et à alléger l'IA Aide. */
  regles: Record<string, string>;
}

async function preparerContexteLibrairie(niche: string): Promise<ContexteLibrairie> {
  const lib = await chargerLibrairie();
  return {
    version: lib.version,
    lib,
    blocCommun: construireBlocCommun(lib),
    blocJuges: construireBlocJuges(lib),
    blocJugeVisuel: construireBlocJugeVisuel(lib),
    blocNiche: construireBlocNiche(lib, niche),
    regles: indexerRegles(lib),
  };
}

/** Clé de cache xAI : stable par rôle, version de Librairie et niche — jamais par site. */
function cleCacheGrok(role: string, ctx: ContexteLibrairie, avecNiche = true): string {
  return `nexai-${role}-${ctx.version}${avecNiche ? `-${ctx.blocNiche.idNiche}` : ''}`;
}

const CONTRAT_TECHNIQUE_CODEUR = `CONTRAT TECHNIQUE NEXAI (non négociable — le système en dépend) :
- Réponds UNIQUEMENT avec le document HTML complet de la page demandée (<!doctype html> … </html>), sans markdown ni explication.
- Une page = un fichier HTML autonome : CSS dans <style>, scripts en ligne en fin de <body>. Liens vers les autres pages du site : "slug.html" (accueil : "index.html") ; ancres "#…" seulement à l'intérieur d'une page.
- <html> porte EXACTEMENT la déclaration de la COMBINAISON IMPOSÉE (lang, data-theme, data-style, data-palette, data-hero, data-nav, data-density, data-env="preview", data-geste) : jamais une autre famille, ouverture, navigation ou densité.
- KIT INSÉRÉ PAR LE SYSTÈME : ne recopie JAMAIS form.js, form.css, motion.js ni GSAP, et ne charge aucun script externe (ni CDN, ni fichier) — le système les ajoute lui-même après ta réponse.
  · Formulaire (composant « formulaire ») : <form id="nx" data-nexai-id="formulaire"></form>, puis dans ton script de fin de page NexaiForm.mount(document.getElementById('nx'), { type, fields, labels, errors }) SANS endpoint (l'envoi est branché par le système), et un <noscript> avec téléphone / WhatsApp cliquables.
  · Mouvement : rien à écrire — kit/motion.js lit data-geste. Haut de page repéré par data-nexai-id="hero" ; aucun texte caché tant qu'un script n'a pas tourné.
- Pied de page : liens "/mentions-legales" et "/confidentialite" (+ "/cgv" si indiqué pour ce site) — pages créées par le système à la mise en ligne, ne les écris pas. Aucun autre lien légal (pas de page cookies).
- SCHEMA : "url": "__SITE_URL__" (remplacé par l'adresse réelle à la mise en ligne) ; ne jamais inventer de domaine.
- Images : UNIQUEMENT les adresses de la liste PHOTOS AUTORISÉES de ce site (sinon variante de section sans photo).
- Attribut data-nexai-id UNIQUE sur chaque bloc de texte modifiable : c'est grâce à lui que le client modifie ses textes.
- Bouton de paiement : si (et SEULEMENT si) le brief indique une vente en ligne, une réservation payante, des dons ou des abonnements, ajoute un bouton bien visible sur une balise <a> portant l'attribut data-nexai-payment-link (ex. <a data-nexai-payment-link href="#">Payer maintenant</a>). JAMAIS de vraie URL de paiement : le lien réel du client est posé automatiquement après coup. Libellé et moyens affichés : règles PAY de la Librairie.
- LONGUEUR (décision du 03/10/2026) : les meilleurs sites sont longs et riches, pas courts. Accueil : au moins 8 sections développées entre l'en-tête et le pied de page ; page intérieure : au moins 4 sections développées. Développe UNIQUEMENT avec le contenu réel du brief (offres et prestations détaillées une à une, déroulé ou étapes, zone et horaires, questions fréquentes tirées du brief, preuves réelles, appel à l'action répété) : n'invente jamais rien pour allonger ; une section sans matière réelle est remplacée par une autre qui en a.
- Qualité : applique STRICTEMENT la Librairie (règles communes ci-dessous + fiche de la niche + famille imposée). Les juges noteront ta page avec exactement ces règles, par numéro.`;

/** Ce qui est propre à UN site (jamais mis en cache) : famille imposée, photos, pages légales. */
interface ExtrasSite {
  combinaison: CombinaisonSite | null;
  photos: IPhotoAutorisee[];
  /** Pages légales créées à la mise en ligne (liens du pied de page). */
  pagesLegales: string[];
}

function pagesLegalesDuSite(brief: Record<string, unknown>): string[] {
  const cgv = typeof brief.cgv === 'string' && brief.cgv.trim().length > 0;
  return ['mentions-legales', 'confidentialite', ...(cgv ? ['cgv'] : [])];
}

/** Bloc propre au site : famille + style + combinaison, photos autorisées, pages légales. */
function blocSite(ctx: ContexteLibrairie, niche: string, extras: ExtrasSite): string {
  return [
    construireBlocFamille(ctx.lib, niche, extras.combinaison),
    textePhotosAutorisees(extras.photos),
    `PAGES LÉGALES DE CE SITE (liens du pied de page) : ${extras.pagesLegales.map((s) => `/${s}`).join(', ')}.`,
  ].join('\n\n');
}

/** Famille en version courte (variables, polices, déclaration) pour le réparateur. */
function familleCourte(ctx: ContexteLibrairie, c: CombinaisonSite | null | undefined): string | undefined {
  if (!c) return undefined;
  const f = familleDe(ctx.lib, c.famille);
  return `${typeof f?.content_md === 'string' ? f.content_md : ''}\nDéclaration imposée : <html lang="…" ${declarationHtml(c)}>`;
}

/** Brief transmis aux IA : sans les adresses des photos (déjà dans PHOTOS AUTORISÉES). */
function briefPourIA(brief: Record<string, unknown>): Record<string, unknown> {
  const { photosClient: _p, ...reste } = brief ?? {};
  return reste;
}

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
  langue: Langue = 'fr',
  extras: ExtrasSite = { combinaison: null, photos: [], pagesLegales: ['mentions-legales', 'confidentialite'] }
): BlocSysteme[] {
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI, en mode qualité Premium.'
    : 'Tu es le Codeur NexAI.';
  const isMultiPage = !!pagePlan && pagePlan.length > 1;
  const multiPageInstructions = isMultiPage
    ? `\n\nCE SITE EST MULTI-PAGES. Plan de pages du site (à respecter dans le header ET le footer de CETTE page d'accueil) : ${pagePlan!
        .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
        .join(', ')}.\nPour chaque page AUTRE que l'accueil, utilise un vrai lien <a href="slug.html">Titre</a> vers son fichier (pas une simple ancre #) ; tu peux garder des ancres # uniquement pour naviguer DANS la page d'accueil elle-même. Tu écris ici la page d'accueil (index.html) seulement : les autres pages sont écrites ensuite, avec la même famille.`
    : '';
  return [
    { texte: ctx.blocCommun, cache: true },
    { texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texte}`, cache: true },
    {
      texte:
        `${identiteCodeur} Tu génères un site vitrine pro en HTML/CSS/JS autonome.\n\n` +
        `${blocSite(ctx, niche, extras)}\n\n` +
        `CE SITE :\n- Niche : ${niche}\n${ligneClientele(brief)}\n- Brief client (JSON) : ${JSON.stringify(briefPourIA(brief))}` +
        `${multiPageInstructions}\n\n${consigneLangue(langue)}`,
    },
  ];
}

// ─── Juges ────────────────────────────────────────────────────────────────

const CONTRAT_SORTIE_JUGE_CODE = `Tu es le Juge Code NexAI. Tu juges le CODE HTML/CSS d'une page avec les règles de la Librairie ci-dessus (bloc commun + JUDGES.md), et la fiche de la niche fournie avec la page.

Réponds en JSON strict uniquement, sans texte autour :
{"vetos": ["M3"], "warns": ["P5"], "score_total": 0, "bloquants": ["M3 : constat court"], "erreurs": [{"erreur_id": "err_001", "regle": "C1", "composant": "...", "data_nexai_id": "...", "critere_viole": "critère du barème", "gravite": "veto|majeur|mineur", "ou": "...", "constat": "...", "correction_attendue": "..."}]}
- "vetos" : UNIQUEMENT les numéros de règles marquées VETO dans la Librairie et réellement violées (liste vide si aucune).
- "score_total" : barème /100 du juge code (JUDGES.md), même s'il y a des vetos.
- Chaque erreur cite le numéro de la règle violée dans "regle". Pas de remarque sans règle : mets-la en conseil dans "constat" d'une erreur "mineur" avec "regle": "conseil".

OBLIGATION DE SOLUTION (ferme, à lire AVANT de juger) : un refus sans solution précise nous fait payer un second passage.
- Page conforme (aucun veto, rien à corriger) : "erreurs": [] et rien d'autre. N'invente jamais un défaut.
- Page non conforme : CHAQUE défaut porte TOUJOURS "regle", "ou" (section, data-nexai-id ou sélecteur ; pour le visuel précise 390 px ou 1280 px), "constat" (mesuré si possible) et "correction_attendue" = la modification PRÉCISE à faire (quoi changer, en quelle valeur, à quel endroit). Interdit : « améliorer », « revoir », « corriger le contraste » sans valeur.
- Un défaut sans correction précise ne doit pas être relevé. Maximum 8 défauts, veto d'abord, une phrase courte par champ.
- Le réparateur applique ta correction à la lettre et n'improvise pas.
- Le kit NexAI (form.js, form.css, motion.js, GSAP) et les pages légales sont ajoutés par le système APRÈS ton jugement : leur absence dans ce code n'est jamais un défaut. La FAMILLE IMPOSÉE fournie avec la page est la référence des contrôles K1–K7.
- MESURES DU PRÉ-JUGE (si fournies) : faits mesurés sur le rendu réel par programme. Ne les contredis pas et ne les répète pas dans "erreurs" (elles sont déjà transmises au réparateur) ; tiens-en compte dans la note.`;

const CONTRAT_SORTIE_JUGE_VISUEL = `Tu es le Juge Visuel NexAI. Tu juges le RENDU RÉEL d'une page (captures téléphone 390 px puis ordinateur 1 280 px) avec les règles visuelles de la Librairie ci-dessus (JUDGES.md : tests V1–V10 et barème du juge visuel ; SLOP ; LAYOUTS ; règles M et PAY), et la fiche de la niche fournie avec les captures. Tu dois TOUJOURS motiver ton verdict.

Réponds en JSON strict uniquement, sans texte autour :
{"vetos": ["V9"], "warns": [], "score_visuel": 0, "ok": true, "raisons": ["V9 : constat court"], "conseils": ["conseil concret"], "erreurs": [{"regle": "V9", "gravite": "veto|majeur|mineur", "ou": "section + 390 px ou 1280 px", "constat": "...", "correction_attendue": "..."}]}
- "vetos" : UNIQUEMENT des numéros de tests marqués VETO réellement violés (liste vide si aucun).
- "ok" : true seulement s'il n'y a aucun veto.
- "score_visuel" : barème /100 du juge visuel (JUDGES.md).

OBLIGATION DE SOLUTION (ferme, à lire AVANT de juger) : un refus sans solution précise nous fait payer un second passage.
- Page conforme (aucun veto, rien à corriger) : "erreurs": [] et rien d'autre. N'invente jamais un défaut.
- Page non conforme : CHAQUE défaut porte TOUJOURS "regle", "ou" (section, data-nexai-id ou sélecteur ; pour le visuel précise 390 px ou 1280 px), "constat" (mesuré si possible) et "correction_attendue" = la modification PRÉCISE à faire (quoi changer, en quelle valeur, à quel endroit). Interdit : « améliorer », « revoir », « corriger le contraste » sans valeur.
- Un défaut sans correction précise ne doit pas être relevé. Maximum 8 défauts, veto d'abord, une phrase courte par champ.
- Le réparateur applique ta correction à la lettre et n'improvise pas.
- "erreurs" : pour tout défaut visuel, suis l'obligation ci-dessus ; "raisons" reste un résumé court.
- La FAMILLE IMPOSÉE fournie avec les captures est la référence du test V10 (style reconnaissable, palette, 1 accent).`;

function systemeJugeCode(ctx: ContexteLibrairie): string {
  return `${ctx.blocCommun}\n\n${ctx.blocJuges}\n\n${CONTRAT_SORTIE_JUGE_CODE}`;
}

function systemeJugeVisuel(ctx: ContexteLibrairie): BlocSysteme[] {
  return [{ texte: `${ctx.blocJugeVisuel}\n\n${CONTRAT_SORTIE_JUGE_VISUEL}`, cache: true }];
}

function buildJudgeCodePrompt(
  html: string,
  ctx: ContexteLibrairie,
  niche: string,
  extra?: { blocSite?: string; mesures?: string }
): string {
  return (
    `${ctx.blocNiche.texte}\n\n${extra?.blocSite ? `${extra.blocSite}\n\n` : ''}Niche du site : ${niche}\n\n` +
    `${extra?.mesures ? `MESURES DU PRÉ-JUGE :\n${extra.mesures}\n\n` : ''}` +
    `HTML à juger :\n${sansKit(html).slice(0, 120000)}`
  );
}

/** Défaut jugé + sa solution. */
interface ErreurJuge { regle?: string; gravite?: string; ou?: string; constat?: string; correction_attendue?: string; [k: string]: unknown }

/**
 * Filet de sécurité SANS nouvel appel de juge : un défaut sans solution précise est complété avec
 * le texte de la règle citée (Librairie) ; sans règle connue il devient un simple conseil.
 * Évite de payer un second jugement.
 */
function completerSolutions(erreurs: ErreurJuge[] | undefined, regles: Record<string, string>): ErreurJuge[] {
  if (!Array.isArray(erreurs)) return [];
  return erreurs.slice(0, 8).map((e) => {
    const id = String(e.regle ?? '').trim();
    const texte = String(e.correction_attendue ?? '').trim();
    if (texte.length >= 15) return e;
    if (id && regles[id]) return { ...e, correction_attendue: `Appliquer la règle ${id} : ${regles[id]}`, solution_source: 'librairie' };
    return { ...e, regle: 'conseil', gravite: 'mineur', correction_attendue: texte || 'Aucune solution précise fournie : ignorer' };
  });
}

function formaterErreurs(erreurs: ErreurJuge[]): string {
  return erreurs
    .map((e) => `- [${e.regle ?? '?'}|${e.gravite ?? '?'}] ${e.ou ?? ''} — ${e.constat ?? ''} → SOLUTION : ${e.correction_attendue ?? ''}`)
    .join('\n');
}

interface VerdictCode {
  score_total?: number;
  vetos?: string[];
  warns?: string[];
  bloquants?: string[];
  erreurs?: ErreurJuge[];
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
  opts: { maxTokens: number; strict?: boolean; blocSite?: string; mesures?: string }
): Promise<VerdictCode | null> {
  // Juge du code SAUTÉ en cas de panne (décision du 09/10/2026) : pas de
  // remplaçant, car pendant une panne de Grok c'est Claude qui code, et un
  // modèle ne juge jamais son propre travail. Les scans automatiques restent.
  let raw: string;
  try {
    raw = await callGrok(
      modele as GrokModel,
      [
        { role: 'system', content: systemeJugeCode(ctx) },
        { role: 'user', content: buildJudgeCodePrompt(html, ctx, niche, { blocSite: opts.blocSite, mesures: opts.mesures }) },
      ],
      {
        maxTokens: opts.maxTokens,
        temperature: opts.strict ? 0 : 0.1,
        cleCache: cleCacheGrok('juge-code', ctx, false),
        sansSecours: true,
      }
    );
  } catch (err) {
    console.warn('[ia-pipeline] Juge Code indisponible — étape sautée', (err as Error)?.message);
    import('@/services/platform-alert.service')
      .then(({ signalerIncident }) =>
        signalerIncident({
          composant: 'integration',
          erreur: `${modele} (juge du code) : ${(err as Error)?.message ?? err}`,
          contexte: 'juge du code sauté',
          categorie: 'serieuse',
        })
      )
      .catch(() => {});
    return null;
  }
  const verdict = parseJsonSafe<VerdictCode>(raw);
  if (verdict) verdict.erreurs = completerSolutions(verdict.erreurs, ctx.regles);
  if (!verdict) {
    console.warn(`[ia-pipeline] Juge Code : JSON invalide. raw=${raw.slice(0, 300).replace(/\n/g, ' ')}`);
  }
  return verdict;
}

function vetosDe(v: { vetos?: unknown } | null | undefined): string[] {
  return Array.isArray(v?.vetos) ? (v!.vetos as unknown[]).map(String).filter(Boolean) : [];
}

// Réparation : voir reparateur.service.ts (corrections ciblées, repli HTML complet).

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
  await exigerTelephoneVerifie(user);

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
    throw new AppError(compliance.clientMessage, 403); // la raison détaillée reste dans les journaux
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

  // Verrou atomique (Redis SET NX) : le garde anti-doublon lit puis décide, donc
  // deux clics simultanés le passaient ensemble — double débit, ou deux
  // relances gratuites en parallèle (à nos frais). Libéré si le lancement échoue ;
  // en cas de succès le Job créé prend le relais comme garde.
  const cleVerrouGeneration = `gen:${siteId}`;
  if (!(await redisConnection.set(cleVerrouGeneration, '1', 'EX', 120, 'NX'))) {
    throw new DuplicateRequestError(
      'Une génération est déjà en cours pour ce site. Patientez quelques instants, elle arrive.'
    );
  }
  const etatAvant = {
    status: site.status,
    freeRelaunchAvailable: site.freeRelaunchAvailable,
    freeRelaunchUsed: site.freeRelaunchUsed,
  };
  let debite = false;
  let siteEssaiReserve = false;
  let bullJob: Awaited<ReturnType<typeof pipelineQueue.add>> | undefined;
  try {
    if (wantsFreeRelaunch) {
      assertRelanceGratuiteAutorisee(site);
      isClientFreeRelaunch = true;
      // ?? et non || : un site offert de l'essai a coûté 0 crédit, à ne pas « rembourser » 12.
      creditCost = site.creditsChargedForGeneration ?? creditCost;
      site.freeRelaunchUsed = true;
      site.freeRelaunchAvailable = false;
    } else if (user.plan === 'trial' && user.role !== 'admin') {
      // Essai gratuit : UN site offert, sans crédit (décision du 10/10/2026).
      // Toute deuxième création est refusée : réservation ATOMIQUE de la
      // date, et refus si le compte a déjà lancé un autre site.
      await assertTrialNotExpired(user);
      const autreSite = await Site.exists({ userId, _id: { $ne: site._id }, generationStartedAt: { $exists: true } });
      const reserve = autreSite
        ? null
        : await User.findOneAndUpdate(
            { _id: userId, siteEssaiOffertLe: { $exists: false } },
            { $set: { siteEssaiOffertLe: new Date() } }
          ).select('_id');
      if (!reserve) throw new AppError(SITE_ESSAI_DEJA_UTILISE, 403);
      siteEssaiReserve = true;
      creditCost = 0;
      site.creditsChargedForGeneration = 0;
      site.depenseCumuleeUsd = 0;
      site.autoRetryUsed = false;
      site.freeRelaunchAvailable = false;
      site.freeRelaunchUsed = false;
      site.freeRelaunchAvailableAt = undefined;
      site.generationRefunded = false;
    } else {
      creditsBalanceAfter = await debitCredits(userId, creditCost, 'apercu_site', {
        relatedSiteId: siteId,
        action: creditAction,
      });
      debite = true;
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

    bullJob = await pipelineQueue.add(
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

  } catch (err) {
    // NexAI n'a pas pu lancer la génération : le client n'a rien reçu par notre
    // faute. On rend le débit, on remet le site dans son état d'avant (sinon il
    // resterait « en génération » sans rien faire) et on libère le verrou.
    await redisConnection.del(cleVerrouGeneration).catch(() => undefined);
    if (bullJob) await (await pipelineQueue.getJob(String(bullJob.id)))?.remove().catch(() => undefined);
    await Site.updateOne(
      { _id: siteId },
      {
        $set: {
          status: etatAvant.status,
          freeRelaunchAvailable: etatAvant.freeRelaunchAvailable ?? false,
          freeRelaunchUsed: etatAvant.freeRelaunchUsed ?? false,
        },
      }
    ).catch((e) => console.error('[ia-pipeline] Site non remis dans son état :', e));
    if (siteEssaiReserve) {
      // Site offert de l'essai rendu : la création n'a pas pu être lancée.
      await User.updateOne({ _id: userId }, { $unset: { siteEssaiOffertLe: 1 } }).catch(() => undefined);
    }
    if (debite) {
      await creditCredits(userId, creditCost, 'ajustement_admin', {
        relatedSiteId: siteId,
        note: 'Remboursement — génération impossible à lancer',
      }).catch((e) => console.error(`[ia-pipeline] ALERTE : remboursement impossible user=${userId} montant=${creditCost}`, e));
    }
    throw err;
  }

  return { jobId: bullJob!.id, status: 'queued', creditsBalance: creditsBalanceAfter };
}

/**
 * Modification IA d'un site existant (coût 8 crédits).
 * Charge le site + brief + HTML choisi, applique l'instruction via Sonnet 5.5
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
  // Couleurs et polices : choisies par le système selon le métier (famille
  // imposée), jamais par le client (décision du 03/10/2026). Refus AVANT
  // tout débit, avec une explication claire.
  if (/\b(couleurs?|colou?rs?|palette|teintes?|polices?|fonts?|typographie)\b/i.test(trimmed)) {
    throw new AppError(
      'Les couleurs et les polices de votre site sont choisies par NexAI selon votre métier, pour garantir un rendu professionnel : elles ne peuvent pas être modifiées. Reformulez votre demande sans elles (contenu, sections, ordre, images…).',
      400
    );
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

  // Verrou atomique (voir enqueueSiteGeneration) : un double-clic ne débite qu'une fois.
  const cleVerrouModif = `modif:${siteId}`;
  if (!(await redisConnection.set(cleVerrouModif, '1', 'EX', 120, 'NX'))) {
    throw new DuplicateRequestError(
      'Une amélioration par IA est déjà en cours sur ce site. Attendez son résultat avant d\'en lancer une autre.'
    );
  }
  const statutAvantModif = site.status;
  let debiteModif = false;
  let bullJob: Awaited<ReturnType<typeof pipelineQueue.add>> | undefined;
  let creditsBalanceAfter: number;
  try {
    creditsBalanceAfter = await debitCredits(userId, CREDIT_COSTS.MODIF_IA, 'modification_niveau2', {
      relatedSiteId: siteId,
      action: 'MODIF_IA',
      note: `ai-modify:${trimmed.slice(0, 80)}`,
    });
    debiteModif = true;

    site.status = 'generating';
    site.generationStartedAt = new Date();
    await site.save();

    bullJob = await pipelineQueue.add(
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
  } catch (err) {
    // La modification n'a pas pu être lancée : rien n'a été fait pour le client.
    await redisConnection.del(cleVerrouModif).catch(() => undefined);
    if (bullJob) await (await pipelineQueue.getJob(String(bullJob.id)))?.remove().catch(() => undefined);
    if (debiteModif) {
      await Site.updateOne({ _id: siteId }, { $set: { status: statutAvantModif } }).catch(() => undefined);
      await creditCredits(userId, CREDIT_COSTS.MODIF_IA, 'ajustement_admin', {
        relatedSiteId: siteId,
        note: 'Remboursement — modification IA impossible à lancer',
      }).catch((e) => console.error(`[ia-pipeline] ALERTE : remboursement impossible user=${userId}`, e));
    }
    throw err;
  }

  return { jobId: bullJob!.id, status: 'queued', creditsBalance: creditsBalanceAfter };
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

  const briefCompact = JSON.stringify(briefPourIA(site.brief || {})).slice(0, 2500);
  // Famille imposée à ce site (Librairie v8) : une modification ne change
  // jamais d'identité visuelle sauf demande explicite du client.
  const libModif = await chargerLibrairie();
  const familleModif = target.combinaison?.famille
    ? `${construireBlocFamille(libModif, site.niche, target.combinaison as CombinaisonSite)}\n\n${textePhotosAutorisees(target.photosAutorisees)}`
    : '';

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
- Garde TOUJOURS la déclaration <html> (data-theme, data-style, data-palette, data-hero, data-nav, data-density, data-geste), les variables :root, les couleurs et les polices de la famille : elles sont imposées par le système selon le métier et ne changent jamais, même si l'instruction le demande.
- Le kit NexAI (formulaire, mouvement, GSAP) est inséré par le système : ne l'ajoute pas, garde l'appel NexaiForm.mount s'il existe.
- Un seul fichier HTML autonome en sortie, page "${pageLabel}" uniquement.${familleModif ? `\n\n${familleModif}` : ''}
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
    // Le modèle travaille sur la page SANS le kit ; il est remis à la fin.
    pageHtml = sansKit(pageHtml);
    // Tour 1 — appliquer l'instruction.
    const raw1 = await callClaude(
      'claude-sonnet-5-5',
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
        'claude-sonnet-5-5',
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
        'claude-sonnet-5-5',
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
        'claude-sonnet-5-5',
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

    return avecKit(sansKit(html), 'apercu');
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
  // Nombre de pages classé par niche : 3 quand le contenu est riche (catalogue, carte, biens, programmes),
  // 2 quand tout tient sur l'accueil + une page d'action, 1 si le brief client n'en demande qu'une.
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
    { slug: 'contact', title: 'Inscription & Contact' },
  ],
  sante_bienetre: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'services', title: 'Nos services' },
    { slug: 'contact', title: 'Rendez-vous & Contact' },
  ],
  business_vitrine: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'expertises', title: 'Nos expertises' },
    { slug: 'contact', title: 'Contact' },
  ],
  // 2 pages : les services locaux tiennent sur l'accueil, le devis est l'action.
  services_locaux: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'devis', title: 'Devis & Contact' },
  ],
  // 2 pages : les projets sont sur l'accueil, la page 2 convertit.
  portfolio_creatif: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'contact', title: 'Contact' },
  ],
  // 2 pages : le produit sur l'accueil, les tarifs à part ; démo/contact en section d'accueil.
  tech_startup_saas: [
    { slug: 'index', title: 'Accueil' },
    { slug: 'tarifs', title: 'Tarifs' },
  ],
};

/**
 * Résout le plan de pages effectif pour un site : priorité au brief client
 * (`brief.pages`, tableau [{slug,title}] optionnel) sinon plan par défaut de
 * la niche, sinon page unique 'index'. Toujours au moins l'entrée 'index'.
 */
export function resolvePagePlan(
  niche: SiteNiche,
  brief: Record<string, unknown>,
  /** Librairie v8 : plan de pages du métier (allowlist.pages) — prioritaire sur PAGES_PAR_NICHE. */
  lib?: LibrairieComplete
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
  const planLibrairie = lib ? planDePagesLibrairie(lib, niche) : null;
  if (planLibrairie) return planLibrairie;
  return PAGES_PAR_NICHE[niche] || [{ slug: 'index', title: 'Accueil' }];
}

function buildSecondaryPageSystemPrompt(
  ctx: ContexteLibrairie,
  niche: SiteNiche,
  brief: Record<string, unknown>,
  isPremium: boolean,
  homepageHtml: string,
  page: { slug: string; title: string },
  allPages: { slug: string; title: string }[],
  extras: ExtrasSite,
  /** Gabarit découpé de l'accueil (option 3B) ; null = ancien mode (le codeur écrit toute la page). */
  gabarit: GabaritSite | null = null
): BlocSysteme[] {
  // Pas de nom de modèle : le modèle réel se règle dans l'admin (Équipe IA).
  const identiteCodeur = isPremium
    ? 'Tu es le Codeur NexAI, en mode qualité Premium.'
    : 'Tu es le Codeur NexAI.';
  const navLinks = allPages
    .map((p) => `${p.slug === 'index' ? 'index.html' : `${p.slug}.html`} (${p.title})`)
    .join(', ');

  const consignePage = gabarit
    ? `${identiteCodeur} Tu écris la page "${page.title}" (fichier ${page.slug}.html) d'un site multi-pages dont l'accueil est terminé et validé.

${blocSite(ctx, niche, extras)}

GABARIT COLLÉ PAR LE SYSTÈME (option fixe, ne pas réécrire) : la déclaration <html>, tout le <head> (polices, variables :root, styles de l'accueil), ${gabarit.header ? "l'EN-TÊTE et " : ''}le PIED DE PAGE de l'accueil sont recopiés À L'IDENTIQUE par le système autour de ta page. Le style est donc déjà identique à l'accueil : tu n'écris QUE ce qui est propre à cette page.

Ce que tu renvoies (un document HTML <!doctype html> … </html> qui contient seulement ces éléments) :
1. <title> et <meta name="description" content="…"> propres à la page.
2. Un seul <style> avec UNIQUEMENT les règles CSS nouvelles dont cette page a besoin. Réutilise d'abord les classes et les variables de l'accueil (CSS ci-dessous). Ne redéfinis jamais :root, les polices, l'en-tête, le pied de page ni les classes existantes.
3. Le contenu central dans <main id="contenu"> … </main> : sections de la page dans l'ordre de la fiche du métier pour cette page, une seule balise <h1>, attributs data-nexai-id UNIQUES préfixés par "${page.slug}-".
4. Un <script> de fin de page SEULEMENT si la page en a besoin (formulaire NexaiForm.mount…). Les scripts de l'accueil sans formulaire sont déjà repris par le système.
${
  gabarit.header
    ? "N'écris ni <header> ni <footer> : ils sont collés par le système."
    : "Écris l'EN-TÊTE de la page (<header> … </header>, placé avant <main>) : une barre de navigation SANS photo de couverture ni titre, avec les mêmes classes, le même nom et les mêmes liens que la NAVIGATION DE L'ACCUEIL ci-dessous, lisible sur fond clair comme sombre (ajoute dans ton <style> les règles nécessaires). N'écris pas de <footer> : il est collé par le système."
}

Navigation du site (déjà dans l'en-tête collé) : ${navLinks}.

Niche : ${niche}
${ligneClientele(brief)}
Brief client : ${JSON.stringify(briefPourIA(brief))}

${gabarit.header ? `EN-TÊTE COLLÉ (lecture seule) :\n${gabarit.header.slice(0, 6000)}` : `NAVIGATION DE L'ACCUEIL (référence à reprendre dans ton en-tête) :\n${gabarit.navReference}`}

PIED DE PAGE COLLÉ (lecture seule) :
${gabarit.footer.slice(0, 4000)}

CSS DE L'ACCUEIL (classes et variables à réutiliser) :
${gabarit.css.slice(0, 20000)}
${
  gabarit.scriptsReference
    ? `\nSCRIPT DE FIN DE L'ACCUEIL (référence ; il monte le formulaire de l'accueil et n'est PAS repris) : s'il contient aussi le menu mobile, recopie cette partie menu à l'identique dans ton script.\n${gabarit.scriptsReference.slice(0, 4000)}\n`
    : ''
}
Réponds uniquement avec ce document HTML.`
    : `${identiteCodeur} Tu génères la page "${page.title}" (slug: ${page.slug}) d'un site multi-pages déjà commencé : un document HTML complet et autonome, <!doctype html> inclus.

${blocSite(ctx, niche, extras)}

RÈGLE ABSOLUE DE COHÉRENCE (TH6) : cette page fait partie du MÊME site que la page d'accueil ci-dessous. Même déclaration <html> (famille, ouverture, navigation, densité, geste), même header/navigation, même footer, mêmes variables :root, mêmes polices et le même contrat data-nexai-id que la page d'accueil. Ne change JAMAIS l'identité visuelle.

Navigation du site (toutes les pages, à inclure dans le header de CETTE page, avec des liens <a href="..."> vers chaque fichier) : ${navLinks}.

Niche : ${niche}
${ligneClientele(brief)}
Brief client : ${JSON.stringify(briefPourIA(brief))}

Page d'accueil du site (référence de style à reproduire strictement, ne PAS la recopier telle quelle — génère le contenu propre à "${page.title}") :
${sansKit(homepageHtml).slice(0, 12000)}

Réponds uniquement avec le HTML complet et autonome de la page "${page.title}".`;

  return [
    { texte: ctx.blocCommun, cache: true },
    { texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texte}`, cache: true },
    { texte: consignePage },
  ];
}

/** Extras d'une proposition (famille et photos décidées lors de la génération de l'accueil). */
function extrasDeProposition(proposal: ISiteProposal, brief: Record<string, unknown>): ExtrasSite {
  const c = proposal.combinaison;
  return {
    combinaison: c && c.famille ? (c as CombinaisonSite) : null,
    photos: proposal.photosAutorisees ?? [],
    pagesLegales: pagesLegalesDuSite(brief),
  };
}

/**
 * Pré-juge par programme d'une page (sans kit) : rendu réel mesuré (kit
 * inclus, comme le verra le visiteur) + images hors liste autorisée.
 */
async function preJuger(htmlSansKit: string, extras: ExtrasSite): Promise<ResultatControle | null> {
  const r = await controlerRendu(avecKit(htmlSansKit, 'apercu'));
  const hors = imagesHorsListe(htmlSansKit, extras.photos.map((p) => p.url));
  if (hors.length === 0) return r;
  const erreur = {
    regle: 'MEDIA',
    gravite: 'veto' as const,
    ou: 'images',
    source: 'pre-juge' as const,
    constat: `adresses d'images hors de la liste PHOTOS AUTORISÉES : ${hors.slice(0, 3).join(' ; ')}`,
    correction_attendue:
      'Remplacer chaque adresse hors liste par une adresse de PHOTOS AUTORISÉES, ou passer la section à sa variante SANS photo.',
  };
  if (!r) return { erreurs: [erreur], vetos: ['MEDIA'], graves: [], mesures: {} };
  return { ...r, erreurs: [erreur, ...r.erreurs].slice(0, 8), vetos: Array.from(new Set(['MEDIA', ...r.vetos])) };
}

/** Mesures du pré-juge, en texte court pour les juges IA. */
function texteMesures(r: ResultatControle | null): string | undefined {
  if (!r) return undefined;
  if (r.erreurs.length === 0 && r.graves.length === 0) return 'Aucun défaut mesuré (M3, M8, M10, TY1, TY4, C1, C2, contenu sans JS, images).';
  return [
    ...r.graves.map((g) => `- GRAVE : ${g}`),
    ...r.erreurs.map((e) => `- [${e.regle}|${e.gravite}] ${e.ou} — ${e.constat}`),
  ].join('\n');
}

/** Liens qui ne visent pas une page du site : ancres et tout schéma d'adresse (https:, tel:, sms:, whatsapp:, geo:…). */
const LIEN_NON_PAGE = /^(#|\/\/|[a-z][a-z0-9+.-]*:)/i;

/**
 * Pages qui existeront une fois le site en ligne : celles du plan, plus les
 * pages légales créées par le système à la mise en ligne (liens du pied de
 * page, à ne jamais signaler ni réécrire).
 */
function fichiersDuSite(plan: { slug: string }[]): Set<string> {
  const fichiers = new Set(plan.map((p) => (p.slug === 'index' ? 'index.html' : `${p.slug}.html`)));
  for (const f of ['index', 'mentions-legales', 'confidentialite', 'cgv']) fichiers.add(`${f}.html`);
  return fichiers;
}

/**
 * Contrôles PAR PROGRAMME propres aux pages intérieures (gratuits, sûrs) :
 * le juge visuel ne regarde que l'accueil, donc on vérifie ici, sans IA,
 * ce qui ferait le plus de tort au client sur une page intérieure :
 * lien vers une page qui n'existe pas, texte de remplissage oublié, titre
 * principal absent, page presque vide.
 */
export function controlerPageInterieure(
  htmlSansKit: string,
  page: { slug: string; title: string },
  plan: { slug: string; title: string }[]
): ErreurMesuree[] {
  const erreurs: ErreurMesuree[] = [];
  const ajouter = (regle: string, gravite: ErreurMesuree['gravite'], ou: string, constat: string, correction: string) =>
    erreurs.push({ regle, gravite, ou, constat, correction_attendue: correction, source: 'pre-juge' });
  const fichiers = fichiersDuSite(plan);

  // 1. Liens internes cassés (vers un fichier .html absent du plan du site).
  const morts = new Set<string>();
  for (const m of htmlSansKit.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (LIEN_NON_PAGE.test(href)) continue;
    const fichier = href.replace(/^\.?\//, '').split(/[?#]/)[0].replace(/\/$/, '');
    if (!fichier || /\.(?!html?$)[a-z0-9]{2,5}$/i.test(fichier)) continue; // fichier non HTML (pdf, image…)
    const cible = /\.html?$/i.test(fichier) ? fichier.replace(/\.htm$/i, '.html') : `${fichier}.html`;
    if (!fichiers.has(cible)) morts.add(href);
  }
  if (morts.size > 0)
    ajouter(
      'NAV',
      'veto',
      'liens',
      `lien(s) vers une page qui n'existe pas : ${[...morts].slice(0, 4).join(', ')}`,
      `Remplacer chaque lien par l'une des pages du site : ${plan.map((p) => (p.slug === 'index' ? 'index.html' : `${p.slug}.html`)).join(', ')} (ou supprimer le lien).`
    );

  // 2. Texte de remplissage oublié.
  const texte = htmlSansKit
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const remplissage = texte.match(/lorem ipsum|dolor sit amet|\[(?:à compléter|a completer|votre [^\]]{1,30}|texte[^\]]{0,20}|placeholder)\]|à compléter par le client|insérez votre|insert your|your text here|votre texte ici/i) ??
    // En majuscules seulement : « todo » est un mot espagnol courant.
    texte.match(/\bTODO\b|\bXXX\b/);
  if (remplissage)
    ajouter(
      'CONTENU',
      'veto',
      'texte',
      `texte de remplissage visible : « ${remplissage[0]} »`,
      'Remplacer ce texte par un vrai contenu tiré du brief du client (activité, services, coordonnées), sans crochets ni texte générique.'
    );

  // 3. Titre principal : exactement un <h1>.
  const h1 = (htmlSansKit.match(/<h1\b/gi) ?? []).length;
  if (h1 === 0)
    ajouter('TY1', 'majeur', 'haut de page', 'aucun titre principal <h1>', `Ajouter un seul <h1> en haut du contenu, reprenant « ${page.title} ».`);
  else if (h1 > 1) ajouter('TY1', 'mineur', 'titres', `${h1} titres <h1> sur la page`, 'Garder un seul <h1> ; passer les autres en <h2>.');

  // 4. Page presque vide (hors en-tête et pied de page).
  const main = htmlSansKit.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? htmlSansKit;
  const texteMain = main.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Une page de contact courte mais dotée d'un formulaire n'est pas vide.
  const seuil = /<form\b/i.test(main) ? 120 : 300;
  if (texteMain.length < seuil)
    ajouter(
      'CONTENU',
      'veto',
      '<main>',
      `contenu principal presque vide (${texteMain.length} caractères)`,
      `Écrire le contenu complet de la page « ${page.title} » : au moins 3 sections utiles tirées du brief.`
    );
  return erreurs;
}

/** Remplace les liens internes vers une page absente par un lien vers l'accueil. */
export function corrigerLiensMorts(html: string, plan: { slug: string }[]): string {
  const fichiers = fichiersDuSite(plan);
  return html.replace(/(<a\b[^>]*\bhref\s*=\s*["'])([^"']+)(["'])/gi, (tout, debut: string, href: string, fin: string) => {
    if (LIEN_NON_PAGE.test(href.trim())) return tout;
    const fichier = href.trim().replace(/^\.?\//, '').split(/[?#]/)[0].replace(/\/$/, '');
    if (!fichier || /\.(?!html?$)[a-z0-9]{2,5}$/i.test(fichier)) return tout;
    const cible = /\.html?$/i.test(fichier) ? fichier.replace(/\.htm$/i, '.html') : `${fichier}.html`;
    return fichiers.has(cible) ? tout : `${debut}index.html${fin}`;
  });
}

/** Ajoute les contrôles des pages intérieures au résultat du pré-juge. */
function avecControlePageInterieure(r: ResultatControle | null, erreurs: ErreurMesuree[]): ResultatControle | null {
  if (erreurs.length === 0) return r;
  const vetos = erreurs.filter((e) => e.gravite === 'veto').map((e) => e.regle);
  if (!r) return { erreurs, vetos: Array.from(new Set(vetos)), graves: [], mesures: {} };
  return { ...r, erreurs: [...erreurs, ...r.erreurs].slice(0, 10), vetos: Array.from(new Set([...vetos, ...r.vetos])) };
}

/** Points de contrôle du juge du code pour une page intérieure (le juge visuel ne la voit pas). */
function consignePageInterieure(page: { slug: string; title: string }, plan: { slug: string; title: string }[]): string {
  const pages = plan.map((p) => `${p.slug === 'index' ? 'index' : p.slug}.html (${p.title})`).join(', ');
  return `PAGE INTÉRIEURE « ${page.title} » (${page.slug}.html). Le juge visuel ne verra PAS cette page : tu es le dernier contrôle avant le client. Sois aussi exigeant que pour l'accueil, et relève en VETO tout ce qui suit :
- un lien interne vers une page absente du site (pages existantes : ${pages}) ou un bouton principal sans destination ;
- un texte de remplissage (Lorem ipsum, [à compléter], « votre texte ici »…) ou un contenu générique sans rapport avec le brief ;
- une section vide, une image sans adresse valide, un formulaire sans champs ni bouton d'envoi ;
- un texte illisible : couleur proche du fond, texte clair sur fond clair ou foncé sur fond foncé, texte posé sur une photo sans voile ;
- une largeur fixe ou un élément qui déborde sur téléphone (390 px), un menu inutilisable sur téléphone ;
- un en-tête ou un pied de page différent de l'accueil (nom, couleurs, liens).
Vérifie aussi : un seul <h1> qui reprend « ${page.title} », des titres dans l'ordre, des textes alternatifs sur les images.`;
}

/**
 * Génère les pages secondaires (au-delà de l'accueil) pour une proposition
 * déjà retenue. Chaque page est jugée comme l'accueil (juge code, pré-juge
 * par programme, réparation). Une page qui échoue est retentée UNE fois ;
 * si elle reste absente ou gravement défectueuse (page blanche, coupée,
 * contenu invisible, texte illisible), elle est listée dans `manquantes` :
 * le site ne peut pas être livré avec un lien vers une page cassée
 * (décision du 02/10/2026 : nouvelle génération).
 */
async function generateSecondaryPagesForProposal(
  proposal: ISiteProposal,
  pagePlan: { slug: string; title: string }[],
  site: { niche: SiteNiche; brief: Record<string, unknown> },
  ctx: ContexteLibrairie,
  isPremium: boolean
): Promise<{ manquantes: string[] }> {
  const homepageHtml = proposal.htmlDemo || '';
  const secondaryPlan = pagePlan.filter((p) => p.slug !== 'index');
  if (secondaryPlan.length === 0 || !homepageHtml) return { manquantes: [] };
  const extras = extrasDeProposition(proposal, site.brief);
  const leBlocSite = blocSite(ctx, site.niche, extras);

  const pages: NonNullable<ISiteProposal['pages']> = [];
  const manquantes: string[] = [];
  // UN seul codeur et UN seul réparateur par site (décision du 03/10/2026) :
  // ceux retenus pour l'accueil. Repli sur le réglage actuel pour un site
  // généré avant cette décision.
  const modelePages =
    proposal.modeleCodeur || (await getModelForRole(isPremium ? 'codeur_premium' : 'codeur_normale'));
  const modeleReparateur = proposal.modeleReparateur || (await getModelForRole('reparateur_code'));
  const modeleJugeCode = await getModelForRole('juge_code');
  // Gabarit de l'accueil (option 3B) : en-tête, pied de page et styles collés par le système.
  const gabarit = extraireGabarit(sansKit(homepageHtml));
  if (!gabarit) console.warn('[ia-pipeline] Gabarit de l’accueil introuvable — pages intérieures en mode complet.');

  const fabriquerPage = async (page: { slug: string; title: string }, avecGabarit: boolean) => {
    const g = avecGabarit ? gabarit : null;
    const prompt = buildSecondaryPageSystemPrompt(ctx, site.niche, site.brief, isPremium, homepageHtml, page, pagePlan, extras, g);
    let html = await appelerCodeur(modelePages, prompt, `Génère la page ${page.slug}.`, {
      sansSecours: isPremium, // site Premium : jamais remplacé
      maxTokens: g ? 14000 : 18000,
      temperature: 0.4,
      cleCache: cleCacheGrok('pages', ctx),
      // Les pages s'enchaînent avec le même début de consigne : la 2e
      // page relit la Librairie depuis le cache.
      reutilisationPrevue: secondaryPlan.length > 1,
    });
    html = sansKit(html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim());
    if (g) {
      const assemblee = assemblerPage(g, html, page);
      if (assemblee) html = assemblee;
      else console.warn(`[ia-pipeline] Page "${page.slug}" : contenu central introuvable — sortie du codeur gardée telle quelle.`);
    }

    // Chaque page intérieure est JUGÉE comme l'accueil (décision admin
    // 26/09/2026) : pré-juge mesuré, veto puis note /100, réparation si besoin.
    let score: number | undefined;
    let vetos: string[] = [];
    let controle = avecControlePageInterieure(await preJuger(html, extras), controlerPageInterieure(html, page, pagePlan));
    const consignePage = consignePageInterieure(page, pagePlan);
    try {
      let verdict = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
        maxTokens: 2500,
        blocSite: `${leBlocSite}\n\n${consignePage}`,
        mesures: texteMesures(controle),
      });
      score = typeof verdict?.score_total === 'number' ? verdict.score_total : undefined;
      vetos = Array.from(new Set([...vetosDe(verdict), ...(controle?.vetos ?? [])]));
      // Réparation si le juge OU les contrôles par programme trouvent un défaut
      // (même quand le juge du code est indisponible).
      const aReparer = vetos.length > 0 || (!!verdict && (score ?? 0) < 80) || (controle?.graves.length ?? 0) > 0;
      if (!plafondDepasse() && aReparer) {
        const rep = await reparerPage({
          modele: modeleReparateur,
          html,
          erreurs: JSON.stringify({
            vetos,
            graves: controle?.graves ?? [],
            erreurs: [...(controle?.erreurs ?? []), ...(verdict?.erreurs ?? [])].slice(0, 12),
          }),
          famille: familleCourte(ctx, extras.combinaison),
        });
        if (rep.html && runScan2(rep.html).ok) {
          html = rep.html;
          controle = avecControlePageInterieure(await preJuger(html, extras), controlerPageInterieure(html, page, pagePlan));
          const verdict2 = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
            maxTokens: 2000,
            blocSite: `${leBlocSite}\n\n${consignePage}`,
            mesures: texteMesures(controle),
          });
          if (verdict2 && typeof verdict2.score_total === 'number') score = verdict2.score_total;
          vetos = Array.from(new Set([...vetosDe(verdict2), ...(controle?.vetos ?? [])]));
        }
      }
    } catch (err) {
      console.warn(`[ia-pipeline] Jugement de la page "${page.slug}" indisponible`, err);
    }
    // Derniers filets, sans IA : un lien mort restant renvoie vers l'accueil ;
    // un texte de remplissage ou une page vide rend la page non livrable
    // (nouvel essai, puis page signalée manquante).
    const restants = controlerPageInterieure(html, page, pagePlan);
    if (restants.some((e) => e.regle === 'NAV')) {
      html = corrigerLiensMorts(html, pagePlan);
      vetos = vetos.filter((v) => v !== 'NAV');
    }
    const graves = [
      ...(controle?.graves ?? []),
      ...restants.filter((e) => e.regle === 'CONTENU').map((e) => `${e.constat} (page intérieure)`),
    ];
    if (vetos.length > 0 && score !== undefined) score = Math.min(score, 59);
    return { html, score, vetos, graves };
  };

  for (const page of secondaryPlan) {
    if (plafondDepasse()) {
      console.warn(`[ia-pipeline] Plafond de dépense atteint — page "${page.slug}" non générée.`);
      manquantes.push(page.slug);
      continue;
    }
    let retenue: { html: string; score?: number; vetos: string[]; graves: string[] } | null = null;
    for (let essai = 1; essai <= 2 && !retenue; essai++) {
      try {
        // 1er essai avec le gabarit collé ; le 2e revient à l'ancien mode (filet de l'option 3B).
        const r = await fabriquerPage(page, essai === 1 && !!gabarit);
        if (r.graves.length === 0) retenue = r;
        else console.warn(`[ia-pipeline] Page "${page.slug}" non livrable (essai ${essai}) : ${r.graves.join(' ; ')}`);
      } catch (err) {
        console.warn(`[ia-pipeline] Page secondaire "${page.slug}" non générée (essai ${essai})`, err);
      }
      if (plafondDepasse()) break;
    }
    if (!retenue) {
      manquantes.push(page.slug);
      continue;
    }
    pages.push({
      slug: page.slug,
      title: page.title,
      html: avecKit(ajouterCredits(retenue.html, extras.photos), 'apercu'),
      score: retenue.score,
      vetos: retenue.vetos,
    });
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
  return { manquantes };
}

/** Crédit des photos de la galerie (Pexels) dans le pied de page, au plus une fois. */
function ajouterCredits(html: string, photos: IPhotoAutorisee[] | undefined): string {
  const credits = creditsPhotos(photos);
  if (credits.length === 0 || !html || html.includes('data-nexai-id="credit-photos"')) return html;
  const ligne = `<p data-nexai-id="credit-photos" style="font-size:.8125rem;margin:.5rem auto 0;padding:0 1rem 1rem;max-width:1200px;text-align:center;color:var(--muted,inherit)">${lignesCredit(credits)}</p>`;
  return /<\/footer>/i.test(html)
    ? html.replace(/<\/footer>/i, () => `${ligne}</footer>`)
    : html.replace(/<\/body>/i, () => `${ligne}</body>`);
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
  opts: { maxTokens: number; temperature: number; cleCache?: string; reutilisationPrevue?: boolean; sansSecours?: boolean },
  /** Rempli avec le modèle qui a réellement écrit le code (après une éventuelle bascule). */
  suivi?: { modeleUtilise?: string }
): Promise<string> {
  // Claude reçoit les blocs (mise en cache explicite) ; Grok reçoit le même
  // texte d'un seul tenant, dans le même ordre (cache automatique xAI sur
  // le début commun, regroupé par la clé de cache).
  // Les clients IA ne basculent jamais d'eux-mêmes ici (sansSecours) : la
  // seule bascule est celle ci-dessous, une fois, d'une famille à l'autre.
  // Sinon le modèle réellement utilisé serait inconnu, et le juge pourrait
  // être le même modèle que le codeur (il jugerait son propre travail).
  const optsClient = { ...opts, sansSecours: true };
  const lancer = (m: string) =>
    m.startsWith('claude-')
      ? callClaude(m as ClaudeModel, systemPrompt, [{ role: 'user', content: instruction }], optsClient)
      : callGrok(
          m as GrokModel,
          [
            { role: 'system', content: systemeEnTexte(systemPrompt) },
            { role: 'user', content: instruction },
          ],
          optsClient
        );

  try {
    const resultat = await lancer(modele);
    compterDernierAppel();
    if (suivi) suivi.modeleUtilise = modele;
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
    // Site Premium : jamais de remplaçant (notre meilleure IA ou rien).
    if (opts.sansSecours) throw err;
    const secours = modeleDeSecours(modele);
    if (!secours || !estIndisponibilite(err)) throw err;

    console.warn(
      `[ia-pipeline] ${modele} indisponible — bascule automatique sur ${secours}. ` +
        `Cause : ${String((err as Error)?.message).slice(0, 120)}`
    );
    const resultat = await lancer(secours);
    compterDernierAppel();
    if (suivi) suivi.modeleUtilise = secours;
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
  return 'claude-sonnet-5-5';
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
  opts?: { forceVariation?: boolean }
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
  return avecCompteurDepense(depense, async () => {
    try {
      return await executerGeneration(site, owner, plan, isPremium, depense, opts);
    } catch (err) {
      // La dépense déjà engagée est gardée : une nouvelle tentative de la même
      // génération repart de ce montant, le plafond reste donc respecté.
      await Site.updateOne({ _id: site._id }, { $set: { depenseCumuleeUsd: Number(depense.totalUsd.toFixed(4)) } }).catch(
        () => undefined
      );
      throw err;
    }
  });
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
  opts?: { forceVariation?: boolean }
): Promise<ISiteProposal[]> {
  const siteId = String(site._id);
  const forceVariation = opts?.forceVariation === true;

  // Un seul aperçu par commande, pour tous les plans (décision du 02/10/2026).
  const previewCount = 1;
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
  const pagePlan = resolvePagePlan(site.niche, site.brief, ctx.lib);
  // Langue du propriétaire du site : le contenu livré doit être dans SA langue
  // (voir consigneLangue), pas dans celle de la plateforme.
  const langueClient: Langue = !owner?.langue || owner.langue === 'fr' ? 'fr' : 'en';
  const proposals: ISiteProposal[] = [];

  // ── Famille et combinaison imposées (Librairie v8, TH1–TH5) ──
  // Jamais une combinaison déjà utilisée dans le métier tant qu'il en reste
  // de libres ; une relance reçoit toujours une combinaison nouvelle.
  const combinaison = await choisirCombinaison({
    lib: ctx.lib,
    nicheSite: site.niche,
    siteId,
    brief: site.brief,
    exclure: site.combinaisonsEssayees ?? [],
  });
  if (combinaison) {
    const cle = cleCombinaison(combinaison);
    site.combinaisonsEssayees = Array.from(new Set([...(site.combinaisonsEssayees ?? []), cle]));
    // Enregistré tout de suite : une reprise après échec doit l'exclure.
    await Site.updateOne({ _id: site._id }, { $addToSet: { combinaisonsEssayees: cle } }).catch(() => undefined);
  } else {
    console.warn(`[ia-pipeline] Aucune famille pour la niche « ${site.niche} » — identité de secours de la fiche.`);
  }

  // ── Photos autorisées, AVANT le codeur (MEDIA.md) ──
  // Choix du client (ses images / galerie NexAI / les deux), puis galerie
  // filtrée et collecte automatique. Remplace l'ancienne pose d'une image
  // de fond après coup, incompatible avec les ouvertures des familles.
  let photosAutorisees: IPhotoAutorisee[] = [];
  try {
    photosAutorisees = await construirePhotosAutorisees({
      lib: ctx.lib,
      niche: site.niche,
      brief: site.brief,
      combinaison,
      siteId,
      plan,
      logoUrl: site.chosenLogoUrl || site.logoProposals?.[0]?.url,
    });
  } catch (err) {
    console.warn('[ia-pipeline] Photos autorisées non constituées — sections sans photo', err);
  }
  const extras: ExtrasSite = { combinaison, photos: photosAutorisees, pagesLegales: pagesLegalesDuSite(site.brief) };
  const leBlocSite = blocSite(ctx, site.niche, extras);
  const famillePourReparateur = familleCourte(ctx, combinaison);

  // UN codeur et UN réparateur pour tout le site (décision du 03/10/2026),
  // lus une seule fois ici : l'accueil, les pages intérieures et une
  // éventuelle finalisation utilisent exactement les mêmes modèles.
  //   · Essai et Standard → codeur_normale (Grok 4.7 par défaut, Sonnet 5.5 en alternance)
  //   · Premium           → codeur_premium (Opus 5.5)
  const modeleCodeurSite = await getModelForRole(isPremium ? 'codeur_premium' : 'codeur_normale');
  const modeleReparateur = await getModelForRole('reparateur_code');
  const reparer = async (pageHtml: string, erreurs: string): Promise<string | null> =>
    (await reparerPage({ modele: modeleReparateur, html: pageHtml, erreurs, famille: famillePourReparateur })).html;

  const runOnePreview = async (i: number): Promise<ISiteProposal | null> => {
    const systemPrompt = buildCoderSystemPrompt(
      ctx,
      site.niche,
      site.brief,
      isPremium,
      pagePlan,
      langueClient,
      extras
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
      : ' TEXTES : clairs, concrets, orientés bénéfice immédiat, fidèles au brief.';
    const consigneStructure =
      ' STRUCTURE : celle de la COMBINAISON IMPOSÉE (ouverture, navigation, densité de la famille), mobile d’abord.';
    const consigneVariation = forceVariation
      ? ` IMPORTANT — cette génération REMPLACE une version jugée insuffisante : la famille et la combinaison imposées ci-dessus sont nouvelles ; change aussi le choix et l'ordre des composants. Ne reproduis pas la structure précédente.`
      : '';

    const userInstruction = `Génère le site du client. Seed Direction Artistique : ${seedDa}.${consigneStructure}${consigneTextes}${consigneVariation}`;

    const modeleCodeur = modeleCodeurSite;
    const suiviCodeur: { modeleUtilise?: string } = {};
    let html = await appelerCodeur(
      modeleCodeur,
      systemPrompt,
      userInstruction,
      {
        sansSecours: isPremium, // site Premium : jamais remplacé
        maxTokens: 22000,
        temperature: 0.5 + i * 0.05,
        cleCache: cleCacheGrok('codeur', ctx),
      },
      suiviCodeur
    );

    // Nettoyage éventuel de fences markdown ; le kit éventuellement recopié
    // par le codeur est retiré (le système l'insère lui-même).
    html = sansKit(html.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim());

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
      sansSecours: isPremium, // site Premium : jamais remplacé
            maxTokens: 16000,
            temperature: 0.3,
            cleCache: cleCacheGrok('codeur', ctx),
          });
          html = continued.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
        } catch (contErr) {
          console.warn('[ia-pipeline] Continue Codeur échoué — bascule Réparateur', contErr);
          const repare = await reparer(html, formatScanIssues(scan1));
          if (repare) html = repare;
        }
      } else {
        // HTML mal formé mais pas tronqué → Réparateur (corrections ciblées)
        const repare = await reparer(html, formatScanIssues(scan1));
        if (repare) html = repare;
      }
    }

    // 2. Juge Code — modèle réglé dans Équipe IA. Il juge avec les règles de
    //    la Librairie (bloc commun + JUDGES.md) : décision en 2 temps,
    //    VETO puis note /100 (voir JUDGES.md).
    const modeleJugeCode = await getModelForRole('juge_code');

    // Pré-juge par programme (checks2.js de la Librairie v8) : mesures sur le
    // rendu réel, sans IA. Ses défauts partent au réparateur avec ceux du juge.
    html = sansKit(html);
    let controle = await preJuger(html, extras);

    // Score par défaut bas si le juge ne répond pas en JSON valide (plus de faux 80 silencieux)
    let score = 55;
    let judge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
      maxTokens: 2500,
      blocSite: leBlocSite,
      mesures: texteMesures(controle),
    });

    if (!judge) {
      // Retry juge UNIQUEMENT plans payants (éviter coût API inutile sur l'essai gratuit)
      if (plan !== 'trial' && plan !== 'starter') {
        console.warn(`[ia-pipeline] Juge Code JSON invalide aperçu ${i} — 1 retry (payant).`);
        try {
          judge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
            maxTokens: 2500,
            strict: true,
            blocSite: leBlocSite,
            mesures: texteMesures(controle),
          });
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
    let vetosCode: string[] = Array.from(new Set([...vetosDe(judge), ...(controle?.vetos ?? [])]));
    if (judge) score = typeof judge.score_total === 'number' ? judge.score_total : 55;

    // 3. Réparation si au moins un veto (juge OU mesure), un bloquant, un
    //    défaut grave mesuré, ou une note < 80.
    const aReparer =
      vetosCode.length > 0 ||
      (controle?.graves.length ?? 0) > 0 ||
      (controle?.erreurs.length ?? 0) > 0 ||
      (!!judge && (score < 80 || (judge.bloquants?.length ?? 0) > 0));
    if (aReparer) {
      const repare = await reparer(
        html,
        JSON.stringify({
          vetos: vetosCode,
          graves: controle?.graves ?? [],
          erreurs: [...(controle?.erreurs ?? []), ...(judge?.erreurs ?? [])].slice(0, 12),
        })
      );
      if (repare) {
        html = sansKit(repare);

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
          const repare2 = await reparer(html, formatScanIssues(scan2));
          if (repare2) html = sansKit(repare2);
        }

        // Re-mesure puis re-jugement après réparation — même juge que
        // ci-dessus (réglage Équipe IA).
        controle = await preJuger(html, extras);
        const rejudge = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
          maxTokens: 2000,
          blocSite: leBlocSite,
          mesures: texteMesures(controle),
        });
        if (rejudge?.score_total != null) {
          score = rejudge.score_total;
          judge = { ...(judge ?? {}), ...rejudge };
        }
        vetosCode = Array.from(new Set([...vetosDe(rejudge ?? judge), ...(controle?.vetos ?? [])]));
      }
    }

    // 4. Juge Visuel — Opus 5.5 par défaut, Sonnet 5.5 quand Opus a codé.
    //    Un modèle ne juge jamais sa propre production (voir
    //    getJugeVisuelPour). Il juge avec les MÊMES règles que le codeur
    //    (Librairie : tests V1–V10 et barème visuel de JUDGES.md) et doit
    //    MOTIVER son verdict (raisons + conseils), réutilisé ensuite par la
    //    correction et par la file d'alertes admin.
    let judgeReasons: string[] = [];
    let judgeAdvice: string[] = [];
    let erreursVisuelles: ErreurJuge[] = [];
    let vetosVisuels: string[] = [];
    try {
      // Juge choisi d'après le modèle qui a RÉELLEMENT codé (bascule comprise).
      const modeleJugeVisuel = await getJugeVisuelPour(suiviCodeur.modeleUtilise ?? modeleCodeur);
      const consigneJuge = systemeJugeVisuel(ctx);

      // Le juge analyse le RENDU RÉEL : captures sur téléphone (390 px) et
      // sur ordinateur (1 280 px). Si la capture échoue, repli sur l'analyse
      // du code : un jugement dégradé vaut mieux qu'une génération bloquée.
      // Captures de la page COMPLÈTE (kit inséré) : ce que verra le visiteur.
      const captures = await captureHtmlScreenshots(avecKit(html, 'apercu'));
      const visualRaw =
        captures.length > 0
          ? await callClaudeVisionBase64(
              modeleJugeVisuel as ClaudeModel,
              consigneJuge,
              `${ctx.blocNiche.texteFiche}\n\n${construireBlocFamille(ctx.lib, site.niche, combinaison)}\n\n` +
                `Niche : ${site.niche}\nScore du code : ${score}\n` +
                `Voici le site rendu, d'abord sur téléphone (390 px), puis sur ordinateur (1 280 px). ` +
                `Juge ce que verra réellement un visiteur, avec les tests V1–V10 de la Librairie, ` +
                `et SURTOUT le comportement sur téléphone (V9, M3).`,
              captures.map(({ base64, mediaType }) => ({ base64, mediaType })),
              // 2 aperçus = 2 jugements par le même modèle, quelques secondes
              // d'écart : la consigne mise en cache au 1er est relue au 2e.
              { maxTokens: 1500, temperature: 0.2, reutilisationPrevue: previewCount > 1, eviterSecours: modeleCodeur }
            )
          : await callClaude(
              modeleJugeVisuel as ClaudeModel,
              consigneJuge,
              [
                {
                  role: 'user',
                  content:
                    `${ctx.blocNiche.texteFiche}\n\n${construireBlocFamille(ctx.lib, site.niche, combinaison)}\n\n` +
                    `Niche: ${site.niche}\nScore code actuel: ${score}\n` +
                    `Capture indisponible : juge d'après le code (début de la page) :\n${html.slice(0, 8000)}`,
                },
              ],
              { maxTokens: 1500, temperature: 0.2, eviterSecours: modeleCodeur }
            );
      const visual = parseJsonSafe<{
        score_visuel: number;
        ok: boolean;
        vetos?: string[];
        raisons?: string[];
        conseils?: string[];
        erreurs?: ErreurJuge[];
      }>(visualRaw);
      if (visual?.score_visuel != null) {
        // Moyenne pondérée simple
        score = Math.round(score * 0.6 + visual.score_visuel * 0.4);
      }
      vetosVisuels = vetosDe(visual);
      if (Array.isArray(visual?.raisons)) judgeReasons = visual.raisons.slice(0, 5);
      if (Array.isArray(visual?.conseils)) judgeAdvice = visual.conseils.slice(0, 5);
      erreursVisuelles = completerSolutions(visual?.erreurs, ctx.regles);
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
    // Déclenchée quand le score final reste sous 70 (essai : aide_ia_essai ; payant : aide_ia_payant).
    // Trois corrections par rapport à la version précédente :
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
    // Essai gratuit compris (rôle « Aide IA — essai gratuit », Sonnet 5.5) :
    // ce rôle existait dans l'admin mais n'était jamais appelé. Le plafond de
    // dépense de l'essai (0,90 $) reste la limite.
    if ((score < 70 || (controle?.graves.length ?? 0) > 0) && !depense.depasse) {
      try {
        const modeleAide = await getModelForRole(plan === 'trial' || plan === 'starter' ? 'aide_ia_essai' : 'aide_ia_payant');

        // Verdicts RÉELS des deux juges. C'est le cœur de la correction :
        // avant, l'IA Aide ne recevait qu'un score chiffré et devait deviner
        // ce qui n'allait pas.
        const verdicts = [
          vetosRestants().length
            ? `VETOS à corriger en priorité (numéros de règles de la Librairie) : ${vetosRestants().join(', ')}`
            : null,
          controle && (controle.graves.length || controle.erreurs.length)
            ? `Pré-juge (mesures sur le rendu réel) — défauts et SOLUTIONS :\n${[
                ...controle.graves.map((g) => `- GRAVE : ${g}`),
                formaterErreurs(controle.erreurs),
              ]
                .filter(Boolean)
                .join('\n')}`
            : null,
          judge?.bloquants?.length
            ? `Juge Code — problèmes BLOQUANTS :\n- ${judge.bloquants.join('\n- ')}`
            : null,
          judge?.erreurs?.length
            ? `Juge Code — défauts et SOLUTIONS à appliquer à la lettre :\n${formaterErreurs(judge.erreurs)}`
            : null,
          erreursVisuelles.length
            ? `Juge Visuel — défauts et SOLUTIONS à appliquer à la lettre :\n${formaterErreurs(erreursVisuelles)}`
            : judgeReasons.length
              ? `Juge Visuel — ce qui ne va pas :\n- ${judgeReasons.join('\n- ')}${judgeAdvice.length ? `\nConseils :\n- ${judgeAdvice.join('\n- ')}` : ''}`
              : null,
        ]
          .filter(Boolean)
          .join('\n\n');

        // Même Librairie que le codeur et les juges : l'IA Aide corrige
        // avec les règles exactes qui ont servi à juger la page.
        const aideHtml = await appelerCodeur(
          modeleAide,
          [
            {
              // Pas toute la Librairie : le contrat, la fiche de la niche et le texte EXACT des seules règles
              // citées par les juges. Les solutions viennent des juges ; l'Aide les applique sans improviser.
              texte: `${CONTRAT_TECHNIQUE_CODEUR}\n\n${ctx.blocNiche.texteFiche}\n\n${leBlocSite}\n\nRÈGLES CITÉES PAR LES JUGES :\n${Array.from(
                new Set([
                  ...vetosRestants(),
                  ...(judge?.erreurs ?? []).map((e) => String(e.regle ?? '')),
                  ...erreursVisuelles.map((e) => String(e.regle ?? '')),
                  ...(controle?.erreurs ?? []).map((e) => e.regle),
                ])
              )
                .filter((id) => ctx.regles[id])
                .map((id) => `- ${id} : ${ctx.regles[id]}`)
                .join('\n')}`,
            },
            {
              texte:
                "Tu es l'IA Aide NexAI. Une page a été jugée insuffisante. Corrige EXACTEMENT les " +
                'problèmes listés en appliquant à la lettre la SOLUTION donnée par le juge (règles citées ci-dessus), vetos d\'abord, sans improviser, en ' +
                'conservant tout ce qui fonctionne : structure, contenu, identité visuelle. Ne repars ' +
                'de zéro que si la page est irrécupérable. Réponds uniquement avec le HTML complet, ' +
                'sans commentaire.\n\n' +
                consigneLangue(langueClient),
            },
          ],
          `Niche : ${site.niche}\n${ligneClientele(site.brief)}\nBrief du client : ${JSON.stringify(briefPourIA(site.brief))}\n\n` +
            `${verdicts || 'Aucun verdict détaillé disponible.'}\n\n` +
            `PAGE ACTUELLE (complète, sans le kit inséré par le système) :\n${sansKit(html)}`,
          { maxTokens: 16000, temperature: 0.3, cleCache: cleCacheGrok('aide', ctx) }
        );

        const htmlAide = sansKit(aideHtml.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim());

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
            controle = await preJuger(html, extras);
            const jugeApres = await appelerJugeCode(modeleJugeCode, ctx, html, site.niche, {
              maxTokens: 2000,
              blocSite: leBlocSite,
              mesures: texteMesures(controle),
            });
            if (typeof jugeApres?.score_total === 'number') {
              score = jugeApres.score_total;
              vetosCode = Array.from(new Set([...vetosDe(jugeApres), ...(controle?.vetos ?? [])]));
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

    // ── Livrable ou pas (décision du 02/10/2026, JUDGES.md « LIVRAISON ») ──
    // Une page faible mais réparable par le client est LIVRÉE. Elle n'est
    // pas livrable seulement si un défaut GRAVE mesuré reste : page blanche,
    // coupée, contenu invisible, texte illisible sur une grande partie.
    // Dans ce cas : erreur « reprenable » → le circuit existant s'applique
    // (nouvelle génération automatique avec une nouvelle combinaison, puis
    // relance gratuite après 30 min, puis remboursement des crédits).
    if (controle && controle.graves.length > 0) {
      throw new AppError(`Site non livrable : ${controle.graves.join(' ; ')}`, 503);
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
      // Page livrée = page du codeur + crédits photo + kit NexAI inséré.
      htmlDemo: avecKit(ajouterCredits(sansKit(html), photosAutorisees), 'apercu'),
      ...(combinaison ? { combinaison } : {}),
      photosAutorisees,
      modeleCodeur,
      modeleReparateur,
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
  let refusNonLivrable: AppError | null = null;
  for (const r of resultats) {
    if (r.status === 'fulfilled' && r.value) proposals.push(r.value);
    else if (r.status === 'rejected') {
      if (r.reason instanceof AppError && /non livrable/i.test(r.reason.message)) refusNonLivrable = r.reason;
      console.warn('[ia-pipeline] Aperçu non livré', r.reason);
    }
  }
  if (proposals.length === 0) {
    if (refusNonLivrable) throw refusNonLivrable;
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

  // Images : la liste PHOTOS AUTORISÉES est constituée AVANT le codeur
  // (voir plus haut) — plus aucune image posée après coup.

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
  //
  // Un seul aperçu (toutes commandes depuis le 02/10/2026) : pages créées
  // tout de suite. Une page qui manque encore après sa 2e tentative, ou qui
  // reste gravement défectueuse, rend le site NON LIVRABLE (lien vers une
  // page cassée, que le client ne peut pas réparer) : nouvelle génération.
  // Seule exception : plafond de dépense atteint — le site part avec ses
  // pages prêtes, le client relance « Finaliser mon site » (gratuit).
  let pagesManquantes: string[] = [];
  try {
    if (pagePlan.length > 1) {
      if (kept.length > 1) {
        for (const p of kept) p.pagesStatut = 'a_finaliser';
      } else {
        for (const p of kept) {
          // Plafond atteint : les pages restent à finaliser (gratuit pour le client).
          if (depense.depasse) {
            p.pagesStatut = 'a_finaliser';
            continue;
          }
          const { manquantes } = await generateSecondaryPagesForProposal(p, pagePlan, site, ctx, isPremium);
          pagesManquantes = manquantes;
          p.pagesStatut = manquantes.length === 0 ? 'pretes' : 'echec';
        }
      }
    }
  } catch (err) {
    console.warn('[ia-pipeline] Pages secondaires non générées', err);
    pagesManquantes = pagePlan.filter((p) => p.slug !== 'index').map((p) => p.slug);
  }
  if (pagesManquantes.length > 0 && !depense.depasse) {
    throw new AppError(`Site non livrable : page(s) ${pagesManquantes.join(', ')} absente(s) ou cassée(s)`, 503);
  }

  site.proposals = kept;
  // Un seul aperçu : il est d'office le site retenu. Sans cela, « Mettre en
  // ligne » depuis la page du site échouait (« Aucune proposition choisie »).
  if (kept.length === 1) site.chosenProposalId = kept[0].versionId;

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
          // Page du site dans le tableau de bord (la route /apercu/… n'existe pas côté frontend).
          lienApercu: `${env.CLIENT_URL.replace(/\/$/, '')}/sites/${site._id}`,
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
      const pagePlan = resolvePagePlan(site.niche, site.brief, ctx.lib);
      const { manquantes } = await generateSecondaryPagesForProposal(proposition, pagePlan, site, ctx, isPremium);
      proposition.pagesStatut = manquantes.length === 0 ? 'pretes' : 'echec';
    });
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
  // Domaine déjà acheté par ce client (page Domaines → « Mes domaines ») :
  // jamais racheté ni refacturé, il est simplement branché sur le site.
  let domaineDejaPossede = false;
  if (opts.domainType === 'godaddy' && resolvedDomainName) {
    const { domainePossede } = await import('@/services/mes-domaines.service');
    domaineDejaPossede = Boolean(await domainePossede(userId, resolvedDomainName));
  }
  if (opts.domainType === 'godaddy' && resolvedDomainName && !domaineDejaPossede) {
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

  // Verrou atomique (Redis SET NX), pris APRÈS les validations (une erreur de saisie ne doit pas bloquer le client) : le garde anti-doublon lit puis décide, donc
  // deux clics simultanés pouvaient le passer ensemble et acheter deux fois le
  // domaine. Le verrou est libéré si le lancement échoue ; en cas de succès,
  // c'est le Job créé plus bas qui prend le relais comme garde.
  const cleVerrouLancement = `launch:${siteId}`;
  if (!(await redisConnection.set(cleVerrouLancement, '1', 'EX', 120, 'NX'))) {
    throw new DuplicateRequestError(
      'La mise en ligne de ce site est déjà en cours. Inutile de relancer, suivez la progression à l\'écran.'
    );
  }

  // Coût mise en ligne
  try {
    await debitCredits(userId, CREDIT_COSTS.METTRE_EN_LIGNE, 'generation_site', {
      relatedSiteId: siteId,
      action: 'METTRE_EN_LIGNE',
    });
  } catch (err) {
    await redisConnection.del(cleVerrouLancement).catch(() => undefined);
    throw err;
  }

  let domainResult: { chargedCredits: number; usedQuota: boolean; budgetSpentUsd?: number } = {
    chargedCredits: 0,
    usedQuota: false,
  };
  try {
    domainResult = await resolveDomainCostAndConsume(userId, domaineDejaPossede ? 'byod' : opts.domainType, {
      relatedSiteId: siteId,
      domainName: resolvedDomainName,
      priceUsd: godaddyPriceUsd,
    });
  } catch (err) {
    // Rembourse le lancement si le domaine échoue après le débit 15 crédits
    await redisConnection.del(cleVerrouLancement).catch(() => undefined);
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
    // Sans ce montant, un lancement raté ne restituait jamais le budget domaine offert.
    domainBudgetSpentUsd: domainResult.budgetSpentUsd ?? 0,
  };

  let bullJob: Awaited<ReturnType<typeof pipelineQueue.add>> | undefined;
  let bullJobId: string | undefined;
  try {
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
      ownedDomain: domaineDejaPossede,
    };

    bullJob = await pipelineQueue.add('launch_site', jobPayload, {
      jobId: `launch_${siteId}_${Date.now()}`,
    });
    bullJobId = String(bullJob.id);

    await Job.create({
      type: 'redeploiement',
      siteId: site._id,
      status: 'queued',
      bullJobId: String(bullJob.id),
      meta: jobPayload,
    });
  } catch (err) {
    // NexAI n'a pas pu lancer la mise en ligne APRÈS les débits : le client n'a
    // rien reçu par notre faute, on rend tout et on libère le verrou.
    await redisConnection.del(cleVerrouLancement).catch(() => undefined);
    if (bullJobId) await (await pipelineQueue.getJob(bullJobId))?.remove().catch(() => undefined);
    await refundLaunchCharges(userId, charges, {
      relatedSiteId: siteId,
      reason: 'remboursement_lancement_impossible',
    }).catch((e) => console.error(`[ia-pipeline] ALERTE : remboursement du lancement impossible user=${userId}`, e));
    throw err;
  }

  return { jobId: bullJob!.id, domainName: resolvedDomainName, charges };
}
