import { controlerHebergement } from '@/services/hebergement.service';
import { Worker, Job as BullJob, UnrecoverableError } from 'bullmq';
import { redisConnection } from '@/config/redis';
import { isRetryableApiError } from '@/services/ai-clients';
import { connectMongo } from '@/config/db';
import { remindersQueue, qualityQueue } from './queue';
import { runStarterConversionReminders } from '@/services/reminders.service';
import {
  runDomainRenewalProvisioning,
  registerPurchasedDomain,
} from '@/services/domain-renewal.service';
import { processGeneration, processAiModify } from '@/services/ia-pipeline.service';
import { processVideoAd } from '@/services/video-pipeline.service';
import { provisionSiteRuntime } from '@/services/site-runtime.service';
import {
  createNetlifySite,
  attachSubdomain,
  attachDomain,
  deploySite,
} from '@/services/netlify.service';
import {
  purchaseDomain,
  addNetlifyDnsRecord,
  checkDomainAvailability,
} from '@/services/godaddy.service';
import { refundLaunchCharges, type LaunchCharges } from '@/services/credits.service';
import { createZipBuffer } from '@/utils/zip';
import { injectPublicBackendScript, injectPaymentLink } from '@/utils/injectBackend';
import { generatePublicApiKey } from '@/utils/crypto';
import { traiterAlertesEnAttente, livrerAlertesBloquees } from '@/services/fable-alerte.service';
import { signalerIncident } from '@/services/platform-alert.service';
import { classerEchec } from '@/services/echec-classifier.service';
import {
  ouvrirRelanceGratuite,
  rembourserGenerationEchouee,
  FREE_RELAUNCH_DELAY_MS,
  SITE_PANNE_BLOQUANTE,
  SITE_RELANCE_GRATUITE_ATTENTE,
} from '@/services/site-relaunch.service';
import { buildRapportQualite, SEUIL_NEGATIF_DECLENCHEMENT } from '@/services/quality-report.service';
import { lancerDiagnosticPrompts } from '@/services/prompt-diagnostic.service';
import { enregistrerVersion } from '@/services/site-versions.service';
import { appliquerCandidatsExpires } from '@/services/prompt-diagnostic.service';
import { scaffoldNextjsProject } from '@/services/nextjs-pipeline.service';
import { buildAndDeployNextjsSite } from '@/services/netlify-nextjs.service';
import { injecterSuivi } from '@/services/site-visits.service';
import { env } from '@/config/env';
import { Site } from '@/models/Site';
import { Job } from '@/models/Job';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Worker BullMQ — traite les jobs longs du pipeline.
 * À lancer séparément : `npm run worker` (ou en process Render Worker).
 */

/** Message client — échec mise en ligne (bref, actionnable). */
const MSG_LAUNCH_FAIL_CLIENT =
  'La mise en ligne a échoué. Réessaie dans quelques instants. Si le problème continue, contacte le support.';

type PipelineJobData = {
  siteId: string;
  userId: string;
  type: string;
  domainType?: 'sous_domaine' | 'godaddy' | 'byod';
  domainName?: string;
  subdomainSlug?: string;
  paymentMode?: 'lien_personnel' | 'chariow';
  paymentLink?: string;
  paymentProvider?: 'chariow' | 'maketou' | 'stripe' | 'autre';
  charges?: LaunchCharges;
  instruction?: string;
  videoAdId?: string;
  /** Relance après refus (admin ou Fable) : le client a déjà payé. */
  skipDebit?: boolean;
  /** Force une composition différente pour ne pas reproduire l'échec précédent. */
  forceVariation?: boolean;
  /**
   * Refabrication décidée par Fable. C'est la PREMIÈRE ET DERNIÈRE : si elle
   * échoue à son tour, le site part dans « Sites à traiter » au lieu de
   * rouvrir une alerte que Fable reprendrait — ce qui produirait une boucle
   * sans fin, chaque tour refabriquant le site à nos frais.
   */
  refabricationFable?: boolean;
  /** Crédits NexAI débités à l'enqueue (traçabilité). */
  creditsCharged?: number;
  /** true = déjà la relance gratuite système (pas de 2e cadeau). */
  freeRelaunchUsed?: boolean;
};

async function handleGeneration(data: PipelineJobData) {
  await Job.updateOne({ siteId: data.siteId, status: 'queued' }, { status: 'active' }).catch(() => {});
  const proposals = await processGeneration(data.siteId, {
    forceVariation: data.forceVariation,
    refabricationFable: data.refabricationFable,
  });
  await Job.updateOne(
    { siteId: data.siteId, bullJobId: { $exists: true } },
    { status: 'completed' }
  ).catch(() => {});
  console.log(`[worker] Génération terminée site=${data.siteId} props=${proposals.length}`);
}

async function handleAiModify(data: PipelineJobData) {
  await Job.updateOne({ siteId: data.siteId, status: 'queued' }, { status: 'active' }).catch(() => {});
  const instruction = data.instruction || '';
  await processAiModify(data.siteId, instruction);
  await Job.updateOne(
    { siteId: data.siteId, bullJobId: { $exists: true } },
    { status: 'completed' }
  ).catch(() => {});
  console.log(`[worker] AI-modify terminé site=${data.siteId}`);
}

async function handleVideoAd(data: PipelineJobData) {
  if (!data.videoAdId) throw new Error('videoAdId manquant sur le job video_ad');
  await Job.updateOne({ siteId: data.siteId, status: 'queued', type: 'video_ad' }, { status: 'active' }).catch(
    () => {}
  );
  // processVideoAd gère elle-même son propre statut (completed/failed). Aucun
  // remboursement en crédits n'existe plus sur ce chemin : un échec total
  // conserve les crédits sur la vidéo et ouvre une relance gratuite au client
  // (voir enqueueVideoAdRelaunch). On ne déclenche donc pas le remboursement
  // générique du catch ci-dessous pour ce type de job.
  await processVideoAd(data.videoAdId);
  await Job.updateOne(
    { siteId: data.siteId, type: 'video_ad', 'meta.videoAdId': data.videoAdId },
    { status: 'completed' }
  ).catch(() => {});
  console.log(`[worker] Vidéo pub terminée videoAdId=${data.videoAdId}`);
}

async function handleLaunch(data: PipelineJobData) {
  const site = await Site.findById(data.siteId);
  if (!site) throw new Error(`Site ${data.siteId} introuvable`);

  await Job.updateOne({ siteId: data.siteId, status: 'queued' }, { status: 'active' }).catch(() => {});

  const chosen = site.proposals.find((p) => p.versionId === site.chosenProposalId);
  const htmlBrut = chosen?.htmlDemo;
  if (!htmlBrut) {
    throw new Error('HTML de la proposition choisie introuvable — impossible de déployer');
  }

  // Script de statistiques injecté à la mise en ligne (Analytics).
  // Sans cookie ni donnée personnelle : le client n'a pas de bandeau de
  // consentement à afficher. Injecté ici plutôt qu'à la génération, pour
  // que l'aperçu privé ne compte pas comme une visite.
  const html = injecterSuivi(htmlBrut, String(site._id));
  // Toutes les pages du site : l'accueil (html, ci-dessus) + les pages
  // secondaires générées pour les sites multi-pages (voir resolvePagePlan /
  // generateSecondaryPagesForProposal dans ia-pipeline.service.ts). Vide pour
  // un site à page unique — comportement historique inchangé dans ce cas.
  let allPages: { slug: string; title: string; html: string }[] = [
    { slug: 'index', title: 'Accueil', html },
    // Les pages secondaires reçoivent le même script : sans cela, seules
    // les visites de l'accueil seraient comptées sur un site multi-pages.
    ...(chosen?.pages || []).map((p) => ({
      ...p,
      html: injecterSuivi(p.html ?? '', String(site._id)),
    })),
  ];

  // Injection du lien de paiement réel (déjà validé en amont, voir
  // enqueueLaunch/payment-link.service.ts) — remplace le repère
  // data-nexai-payment-link généré par le Codeur. Sans effet si le Codeur
  // n'a généré aucun bouton de paiement (site sans besoin de paiement).
  const resolvedPaymentLink = data.paymentLink || site.paymentLink;
  if (resolvedPaymentLink) {
    allPages = allPages.map((p) => ({ ...p, html: injectPaymentLink(p.html, resolvedPaymentLink) }));
  }

  // Slug Netlify / sous-domaine
  const slug = (
    data.subdomainSlug ||
    data.domainName?.replace(/\.nexai\.com$/i, '') ||
    `site-${data.siteId}`
  )
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
    .slice(0, 40);

  // 1. Création site Netlify
  let netlifySiteId = site.netlifySiteId;
  // Le sous-domaine NexAI est mémorisé sur le site, quel que soit le type de
  // domaine choisi : c'est l'adresse de repli si un domaine personnalisé
  // expire un jour.
  if (site.subdomainSlug !== slug) {
    site.subdomainSlug = slug;
    await site.save();
  }

  if (!netlifySiteId) {
    try {
      const created = await createNetlifySite(`nexai-${slug}`.slice(0, 60));
      netlifySiteId = created.id;
      site.netlifySiteId = netlifySiteId;
      await site.save();
    } catch (err) {
      console.warn('[worker] Netlify create failed', err);
      // En dev sans token : id local, pas de vrai deploy
      if (process.env.NODE_ENV === 'production') throw err;
      netlifySiteId = `local_${data.siteId}`;
      site.netlifySiteId = netlifySiteId;
    }
  }

  // Clé publique du site — générée une seule fois, utilisée par le HTML/JS ou le
  // projet Next.js livré pour authentifier ses appels au backend public (voir
  // routes/public.routes.ts). Nécessaire dans les deux branches (static/nextjs).
  if (!site.publicApiKey) {
    site.publicApiKey = generatePublicApiKey();
    await site.save();
  }

  // 2. Déploiement du contenu — deux chemins selon le type de site.
  if (!String(netlifySiteId).startsWith('local_')) {
    if (site.siteType === 'nextjs') {
      // Site complexe : scaffold + build + déploiement d'un vrai projet Next.js
      // (une page + une route API par page du plan, voir nextjs-pipeline.service.ts).
      const projectDir = await mkdtemp(path.join(tmpdir(), `nexai-nextjs-${data.siteId}-`));
      try {
        await scaffoldNextjsProject({
          targetDir: projectDir,
          siteId: String(site._id),
          siteName: site.name || String(site._id),
          pages: allPages,
          publicApiKey: site.publicApiKey,
          publicApiBaseUrl: env.PUBLIC_API_BASE_URL,
        });
        const deploy = await buildAndDeployNextjsSite({ projectDir, netlifySiteId: String(netlifySiteId) });
        console.log(`[worker] Deploy Next.js OK site=${data.siteId} url=${deploy.url} pages=${allPages.length}`);
      } catch (err) {
        console.error('[worker] Deploy Next.js failed', err);
        throw err; // déclenche remboursement
      } finally {
        await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      // Site statique : une page HTML par entrée du plan, chacune avec les
      // formulaires câblés sur le backend public (sinon ils n'envoient les
      // données nulle part).
      const zipEntries = allPages.map((p) => ({
        path: p.slug === 'index' ? 'index.html' : `${p.slug}.html`,
        content: injectPublicBackendScript({
          html: p.html,
          siteId: String(site._id),
          publicApiKey: site.publicApiKey!,
          apiBaseUrl: env.PUBLIC_API_BASE_URL,
        }),
      }));
      const zipBuffer = createZipBuffer(zipEntries);
      try {
        const deploy = await deploySite(netlifySiteId, zipBuffer);
        console.log(`[worker] Deploy OK site=${data.siteId} url=${deploy.url} pages=${allPages.length}`);
      } catch (err) {
        console.error('[worker] Deploy failed', err);
        throw err; // déclenche remboursement
      }
    }
  } else {
    console.warn('[worker] Skip deploy (netlify local stub)');
  }

  // 3. Domaine
  if (data.domainType === 'sous_domaine') {
    try {
      await attachSubdomain(netlifySiteId, slug);
    } catch (err) {
      console.warn('[worker] attachSubdomain failed', err);
      // non bloquant si le deploy a réussi (URL netlify.app existe)
    }
  } else if (data.domainType === 'godaddy' && data.domainName) {
    try {
      // checkDomainAvailability renvoie un OBJET { available, priceUsd } :
      // tester l'objet directement serait toujours vrai et achèterait un
      // domaine indisponible. On déstructure explicitement.
      // priceUsd est le prix RÉEL de ce nom exact : il sert à calculer le
      // provisionnement du renouvellement (une variante premium n'a pas le
      // même tarif qu'un nom standard sur la même extension).
      const { available, priceUsd } = await checkDomainAvailability(data.domainName);
      if (available) {
        await purchaseDomain(data.domainName, 1);
        console.log(`[worker] Domaine acheté: ${data.domainName}`);
        // Arme le provisionnement du renouvellement (renewAuto est désactivé
        // chez GoDaddy : sans cet enregistrement, le domaine expirerait sans
        // que personne ne provisionne sa 2ème année).
        try {
          await registerPurchasedDomain({
            userId: data.userId,
            siteId: data.siteId,
            domainName: data.domainName,
            usedFreeQuota: data.charges?.usedDomainQuota ?? false,
            freeBudgetSpentUsd: data.charges?.domainBudgetSpentUsd ?? 0,
            creditsChargedAtPurchase: data.charges?.domainCredits ?? 0,
            observedPriceUsd: priceUsd,
          });
        } catch (regErr) {
          // Ne doit jamais faire échouer un lancement réussi : on signale.
          console.error('[worker] registerPurchasedDomain échoué', regErr);
        }
      } else {
        // Déjà vérifié à l'enqueue — si plus dispo, échec dur pour remboursement
        throw new Error(`Domaine ${data.domainName} plus disponible au moment de l'achat`);
      }
      const netlifyTarget = `${slug}.netlify.app`;
      try {
        await addNetlifyDnsRecord(data.domainName, netlifyTarget);
      } catch (dnsErr) {
        console.warn('[worker] addNetlifyDnsRecord failed', dnsErr);
      }
      await attachDomain(netlifySiteId, data.domainName, slug);
    } catch (err) {
      console.error('[worker] godaddy failed', err);
      throw err;
    }
  } else if (data.domainType === 'byod' && data.domainName) {
    try {
      await attachDomain(netlifySiteId, data.domainName, slug);
    } catch (err) {
      console.warn('[worker] attachDomain BYOD failed — client doit pointer DNS', err);
      // BYOD : le client configure son DNS ; on ne fait pas échouer tout le lancement
    }
  }

  // 4. Provision runtime (MongoDB)
  const paymentMode = data.paymentMode || site.paymentMode || 'lien_personnel';
  const provision = await provisionSiteRuntime({
    siteId: String(site._id),
    niche: site.niche,
    paymentMode,
    paymentLink: resolvedPaymentLink,
    paymentProvider: data.paymentProvider || site.paymentProvider,
    domainName: data.domainName,
  });
  site.runtimeId = provision.runtimeId;
  site.capacites = provision.capacites;
  // Archive la version mise en ligne (Architecture v6, section 10) :
  // le client peut ainsi revenir exactement à ce qui était publié.
  await enregistrerVersion(site._id, 'mise_en_ligne', 'Site mis en ligne');

  site.status = 'launched';
  site.clientMessage = undefined;
  site.lastError = undefined;
  await site.save();

  await Job.updateOne(
    { siteId: data.siteId, type: 'redeploiement' },
    { status: 'completed' }
  ).catch(() => {});

  console.log(
    `[worker] Site lancé site=${data.siteId} netlify=${netlifySiteId} runtime=${provision.runtimeId}`
  );
}

async function processJob(job: BullJob<PipelineJobData>) {
  const { type } = job.data;
  console.log(`[worker] Job ${job.id} type=${type}`);

  try {
    switch (type) {
      case 'generation_site':
        await handleGeneration(job.data);
        break;
      case 'ai_modify':
        await handleAiModify(job.data);
        break;
      case 'launch_site':
        await handleLaunch(job.data);
        break;
      case 'video_ad':
        await handleVideoAd(job.data);
        break;
      // 'logo', 'repair', 'modification_bloc', 'modification_structurelle' :
      // ces types existent dans le modèle Job comme LIBELLÉS de suivi, mais
      // ne transitent jamais par la file. Les logos sont générés en direct
      // par la route HTTP (logos.routes.ts → recraft.service.ts) et les
      // modifications passent par le job 'ai_modify' ci-dessus. Aucun
      // traitement n'est donc attendu ici.
      default:
        console.warn(`[worker] Type de job inconnu: ${type}`);
    }
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    const maxAttempts = job.opts.attempts ?? 2;
    const attempt = job.attemptsMade || 1;
    const retryable = isRetryableApiError(err);
    const isFinalAttempt = attempt >= maxAttempts || !retryable;

    console.error(
      `[worker] Échec job ${job.id} type=${type} site=${job.data.siteId} ` +
        `tentative ${attempt}/${maxAttempts} retryable=${retryable} — ${errMsg}`
    );

    // launch_site : remboursement charges uniquement à l'échec final
    if (isFinalAttempt && type === 'launch_site' && job.data.charges && job.data.userId) {
      try {
        await refundLaunchCharges(job.data.userId, job.data.charges, {
          relatedSiteId: job.data.siteId,
          reason: `remboursement_lancement_echoue:${errMsg.slice(0, 120)}`,
        });
        console.log(`[worker] Remboursement lancement user=${job.data.userId}`);
      } catch (refundErr) {
        console.error('[worker] Échec remboursement lancement', refundErr);
      }
    }

    // generation_site : 1 reprise auto BullMQ (erreurs transitoires uniquement).
    // Si elle échoue aussi → relance gratuite client (après 30 min).
    // Relance client déjà utilisée → remboursement.
    // Panne bloquante → pas de reprise auto, relance gratuite immédiate.
    if (isFinalAttempt && type === 'generation_site' && job.data.userId) {
      const clientFreeAlready = job.data.freeRelaunchUsed === true;
      const credits = job.data.creditsCharged ?? 0;
      try {
        if (clientFreeAlready) {
          await rembourserGenerationEchouee(job.data.siteId, job.data.userId, credits, errMsg);
          console.warn(`[worker] Remboursement génération site=${job.data.siteId} crédits=${credits}`);
        } else if (retryable) {
          await ouvrirRelanceGratuite(job.data.siteId, {
            delayMs: FREE_RELAUNCH_DELAY_MS,
            clientMessage: SITE_RELANCE_GRATUITE_ATTENTE,
            lastError: errMsg,
          });
          await Site.findByIdAndUpdate(job.data.siteId, { autoRetryUsed: true }).catch(() => {});
        } else {
          await ouvrirRelanceGratuite(job.data.siteId, {
            delayMs: 0,
            clientMessage: SITE_PANNE_BLOQUANTE,
            lastError: errMsg,
          });
        }
      } catch (relaunchErr) {
        console.error('[worker] Impossible d’ouvrir la relance / remboursement', relaunchErr);
      }
    }

    if (!isFinalAttempt) {
      await Site.findByIdAndUpdate(job.data.siteId, {
        status: 'generating',
        lastError: `[tentative ${attempt}/${maxAttempts}] ${errMsg}`.slice(0, 1000),
        clientMessage:
          'Un contretemps est survenu. Nous relançons automatiquement la création. Merci de patienter, cela peut prendre quelques minutes de plus.',
      }).catch(() => {});
      throw err;
    }

    const clientMsg = type === 'launch_site' ? MSG_LAUNCH_FAIL_CLIENT : undefined;

    await Site.findByIdAndUpdate(job.data.siteId, {
      status: 'failed',
      lastError: errMsg.slice(0, 1000),
      ...(clientMsg ? { clientMessage: clientMsg } : {}),
    }).catch(() => {});
    await Job.updateOne(
      { siteId: job.data.siteId, status: { $in: ['queued', 'active'] } },
      { status: 'failed', error: errMsg.slice(0, 1000) }
    ).catch(() => {});

    if (!retryable && !(err instanceof UnrecoverableError)) {
      throw new UnrecoverableError(errMsg);
    }
    throw err;
  }
}

/**
 * Filet automatique : sites / jobs restés "generating" ou "active" trop longtemps
 * (worker crash, Redis, job zombie). Sans IA — pure règle de temps.
 * Seuil : 15 minutes. Passe en failed + lastError admin (pas de relance auto ici :
 * la relance gratuite s'applique déjà sur les fails système "vivants").
 */
/**
 * Garde contre les générations réellement bloquées.
 *
 * DOIT rester supérieure au budget maximal d'un appel IA : le délai par
 * appel atteint ~7,4 min pour une génération de page complète (16 000
 * tokens), et jusqu'à 3 tentatives sont possibles, soit ~22 min. Une garde
 * plus courte tuait la génération AVANT la fin des tentatives — la
 * génération ne pouvait donc jamais aboutir dès qu'un premier appel était
 * lent, et l'échec ressemblait à une panne fournisseur.
 */
const STUCK_GENERATION_MS = 30 * 60 * 1000;

async function recupererGenerationsBloquees(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_GENERATION_MS);
  let n = 0;

  const stuckSites = await Site.find({
    status: 'generating',
    updatedAt: { $lt: cutoff },
  })
    .select('_id')
    .limit(50)
    .lean();

  for (const s of stuckSites) {
    await Site.findByIdAndUpdate(s._id, {
      status: 'failed',
      lastError:
        'Timeout automatique : génération bloquée plus de 15 minutes (worker/job interrompu). Relance possible depuis l\'admin.',
    }).catch(() => {});
    await Job.updateMany(
      { siteId: s._id, status: { $in: ['queued', 'active'] } },
      {
        status: 'failed',
        error: 'Timeout automatique > 15 min — job considéré bloqué',
      }
    ).catch(() => {});
    n += 1;
  }

  if (n > 0) {
    console.warn(`[worker] ${n} génération(s) bloquée(s) passée(s) en failed (timeout 30 min)`);
  }
  return n;
}

/**
 * Concurrences, réglables SANS redéploiement via les variables Render.
 *
 * Les deux charges n'ont pas le même profil :
 *  - SITES : surtout de l'attente réseau (appels aux modèles IA), très peu de
 *    CPU. Supporte une concurrence élevée même sur une petite instance.
 *  - VIDÉOS : se terminent par un montage ffmpeg qui sature un cœur entier.
 *    La concurrence ne doit jamais dépasser le nombre de cœurs réellement
 *    disponibles, sinon TOUS les montages ralentissent en même temps.
 *
 * Repères par plan Render (à ajuster en observant la charge réelle) :
 *   Starter  (0,5 CPU / 512 Mo) : SITE=2  VIDEO=1
 *   Standard (1 CPU / 2 Go)     : SITE=4  VIDEO=1
 *   Pro      (2 CPU / 4 Go)     : SITE=8  VIDEO=2
 *   Pro Plus (4 CPU / 8 Go)     : SITE=12 VIDEO=4
 */
function readConcurrency(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  // Borne haute de sécurité : au-delà, la mémoire de l'instance lâche avant
  // que le débit n'augmente.
  return Math.min(parsed, 32);
}

/**
 * Workers actifs, pour pouvoir les arrêter proprement (voir stopWorkers).
 * Rempli au démarrage, vidé à l'arrêt.
 */
const activeWorkers: Worker[] = [];

/**
 * Arrêt PROPRE des workers.
 *
 * Render envoie SIGTERM à chaque déploiement. Sans cet arrêt contrôlé, une
 * génération en cours serait tuée net : le client aurait été débité, le
 * fournisseur (fal, Alexya, ElevenLabs) facturé, et la vidéo perdue.
 *
 * `close()` laisse les jobs EN COURS se terminer et cesse d'en prendre de
 * nouveaux. Une limite de temps évite qu'un job bloqué empêche indéfiniment le
 * redéploiement — au-delà, Render tuerait le processus de toute façon.
 */
export async function stopWorkers(timeoutMs = 25_000): Promise<void> {
  if (activeWorkers.length === 0) return;
  console.log(`[worker] Arrêt propre de ${activeWorkers.length} worker(s)...`);
  await Promise.race([
    Promise.all(activeWorkers.map((w) => w.close())),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  activeWorkers.length = 0;
  console.log('[worker] Workers arrêtés');
}

/**
 * Signale un échec technique à l'administrateur, si sa cause l'exige.
 *
 * Les surcharges passagères restent silencieuses : un nouvel essai suffit.
 * Tout le reste — bug interne, déploiement bloqué, clé ou crédits épuisés,
 * fournisseur en panne — remonte, avec un libellé explicite. Une même panne
 * touchant de nombreux clients ne produit qu'une seule alerte (voir
 * l'empreinte de signalerIncident).
 */
function signalerEchecTechnique(err: Error, contexte: string, typeJob?: string): void {
  const echec = classerEchec(err, contexte);
  if (!echec.alerter) return;
  signalerIncident({
    composant: contexte,
    erreur: `${echec.libelle} — ${err.message}`,
    stack: err.stack,
    contexte: typeJob ? `${contexte}:${typeJob}` : contexte,
    gravite: echec.gravite,
    categorie: echec.responsable,
  }).catch(() => {});
}

export async function startWorker() {
  await connectMongo();

  const siteConcurrency = readConcurrency('WORKER_SITE_CONCURRENCY', 2);
  const videoConcurrency = readConcurrency('WORKER_VIDEO_CONCURRENCY', 1);

  // ── File SITES : génération, modification IA, mise en ligne ──
  const worker = new Worker<PipelineJobData>('pipeline', processJob, {
    connection: redisConnection,
    concurrency: siteConcurrency,
  });

  // ── File VIDÉOS : publicités IA ──
  //
  // Worker SÉPARÉ sur une file distincte : c'est ce qui garantit qu'une
  // commande de site n'attend jamais derrière des vidéos, et inversement.
  // Les deux workers tournent en parallèle, chacun avec sa propre capacité.
  const videoWorker = new Worker<PipelineJobData>('pipeline-video', processJob, {
    connection: redisConnection,
    concurrency: videoConcurrency,
  });

  videoWorker.on('completed', (job) => {
    console.log(`[worker:video] ✅ Job ${job.id} completed`);
  });

  videoWorker.on('failed', (job, err) => {
    console.error(
      `[worker:video] ❌ Job ${job?.id} type=${job?.data?.type} FAILED — ${err.message}`
    );
    signalerEchecTechnique(err, 'generation-video', job?.data?.type);
  });

  console.log(
    `[worker] Concurrence — sites=${siteConcurrency} vidéos=${videoConcurrency}`
  );

  worker.on('completed', (job) => {
    console.log(`[worker] ✅ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[worker] ❌ Job ${job?.id} type=${job?.data?.type} site=${job?.data?.siteId} FAILED — ${err.message}`
    );
    // Une mise en ligne qui échoue bloque directement un client : on la
    // distingue d'une génération pour que l'alerte soit explicite.
    const contexte = job?.data?.type === 'launch_site' ? 'deploiement' : 'generation-site';
    signalerEchecTechnique(err, contexte, job?.data?.type);
  });

  // Pub 4 (Partie commerciale) — scan de relance différée Coach business,
  // toutes les heures. jobId fixe : un seul scheduler répétable, même si le
  // worker redémarre plusieurs fois.
  const remindersWorker = new Worker(
    'reminders',
    async () => {
      const { scanned, sent } = await runStarterConversionReminders();
      console.log(`[worker] Relance Coach business — scanné=${scanned} envoyé=${sent}`);

      // Provisionnement mensuel du renouvellement des domaines.
      // Rejoué toutes les heures sans risque : lastChargeAt garantit qu'un
      // domaine n'est prélevé qu'une fois par mois (voir isChargeDue).
      try {
        const d = await runDomainRenewalProvisioning();
        console.log(
          `[worker] Domaines — scanné=${d.scanned} prélevé=${d.charged} ` +
            `interrompu=${d.interrupted} prêt=${d.readyToRenew} ` +
            `renouvelé=${d.renewed} échec=${d.renewFailed} expiré=${d.expired} rappels=${d.remindersSent}`
        );
      } catch (e) {
        console.error('[worker] Provisionnement domaines échoué', e);
      }

      // Contrôle de l'hébergement gratuit : quota de visiteurs, gradation
      // des avertissements, suspension et rétablissement automatiques.
      // Exécuté une seule fois par jour — le comptage des visites est plus
      // lourd que les autres tâches horaires.
      try {
        const heure = new Date().getUTCHours();
        if (heure === 3) {
          const h = await controlerHebergement();
          console.log(
            `[worker] Hébergement — contrôlés=${h.controles} dépassements=${h.depassements} ` +
              `suspendus=${h.suspendus} rétablis=${h.retablis}`
          );
        }
      } catch (e) {
        console.error('[worker] Contrôle hébergement échoué', e);
      }
    },
    { connection: redisConnection, concurrency: 1 }
  );
  remindersWorker.on('failed', (job, err) => {
    console.error(`[worker] ❌ Relance Coach business échouée`, err.message);
  });

  await remindersQueue.add(
    'scan-starter-conversion',
    {},
    {
      repeat: { every: 60 * 60 * 1000 }, // toutes les heures
      jobId: 'scan-starter-conversion-hourly',
    }
  );

  // ── Agent qualité Fable + application automatique des prompts ──
  //
  // Toutes les minutes : le délai de décision de Fable est de 3 min, un
  // balayage plus lent rendrait l'attente imprévisible. La promesse
  // commerciale « site en 10 minutes » impose cette réactivité. Les alertes déjà tranchées
  // par l'admin sont ignorées automatiquement (statut ≠ 'ouverte') — la
  // décision humaine prime toujours tant que rien n'a été appliqué.
  const qualityWorker = new Worker(
    'quality-agent',
    async () => {
      // Filet jobs/sites bloqués (sans IA) — avant les décisions Fable
      try {
        await recupererGenerationsBloquees();
      } catch (e) {
        console.error('[worker] Récupération générations bloquées échouée', e);
      }

      const alertes = await traiterAlertesEnAttente();
      if (alertes > 0) {
        console.log(`[worker] Fable a traité ${alertes} alerte(s) qualité`);
      }
      // Même mécanique pour les propositions de prompts : silence de
      // l'admin pendant 1h = Fable applique (voir prompt-diagnostic.service).
      // Filet de sécurité : livrer les sites payants qu'aucune décision n'a
      // débloqués depuis 1h (Fable indisponible) — jamais 0 aperçu.
      const secours = await livrerAlertesBloquees();
      if (secours > 0) {
        console.warn(`[worker] ${secours} site(s) livré(s) en secours (aucune décision dans le délai)`);
      }

      // Seuil négatif à 40% : déclenche automatiquement le diagnostic
      // Fable (Architecture v6, section 18). Vérifié une fois par heure
      // seulement — inutile de recalculer le rapport toutes les minutes.
      if (new Date().getMinutes() === 0) {
        try {
          const rapport = await buildRapportQualite(30);
          if (rapport.seuilNegatifGlobal >= SEUIL_NEGATIF_DECLENCHEMENT) {
            console.warn(
              `[worker] Seuil négatif à ${rapport.seuilNegatifGlobal}% — diagnostic des prompts déclenché`
            );
            await lancerDiagnosticPrompts({ forcer: false });
          }
        } catch (e) {
          console.error('[worker] Vérification du seuil qualité échouée', e);
        }
      }

      const prompts = await appliquerCandidatsExpires();
      if (prompts > 0) {
        console.log(`[worker] ${prompts} proposition(s) de prompt appliquée(s) automatiquement`);
      }
    },
    { connection: redisConnection }
  );

  qualityWorker.on('failed', (_job, err) => {
    console.error('[worker] ❌ Agent qualité en échec', err.message);
    signalerIncident({
      composant: 'worker',
      erreur: err.message,
      stack: err.stack,
      contexte: 'agent-qualite',
    }).catch(() => {});
  });

  await qualityQueue.add(
    'scan-alertes-qualite',
    {},
    {
      repeat: { every: 60 * 1000 }, // toutes les minutes
      jobId: 'scan-alertes-qualite',
    }
  );

  activeWorkers.push(worker, videoWorker, remindersWorker, qualityWorker);

  console.log(
    '🔧 NexAI BullMQ worker démarré (queues: pipeline, pipeline-video, reminders, quality-agent)'
  );
}

// Démarrage automatique UNIQUEMENT si ce fichier est lancé directement
// (service Worker dédié). Quand il est importé par server.ts — mode
// mono-service pour les tests — c'est server.ts qui décide du lancement.
const lanceDirectement =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('worker.js') || process.argv[1].endsWith('worker.ts'));

if (lanceDirectement) {
  startWorker().catch((err) => {
    console.error('Worker crash', err);
    process.exit(1);
  });

  // Service Worker dédié : il gère lui-même ses signaux d'arrêt. En mode
  // mono-service, c'est server.ts qui appelle stopWorkers().
  const arret = async (signal: string) => {
    console.log(`\n${signal} reçu — arrêt du worker...`);
    await stopWorkers();
    process.exit(0);
  };
  process.on('SIGINT', () => void arret('SIGINT'));
  process.on('SIGTERM', () => void arret('SIGTERM'));
}
