import { Worker, Job as BullJob } from 'bullmq';
import { redisConnection } from '@/config/redis';
import { connectMongo } from '@/config/db';
import { remindersQueue } from './queue';
import { runStarterConversionReminders } from '@/services/reminders.service';
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
import { scaffoldNextjsProject } from '@/services/nextjs-pipeline.service';
import { buildAndDeployNextjsSite } from '@/services/netlify-nextjs.service';
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
};

async function handleGeneration(data: PipelineJobData) {
  await Job.updateOne({ siteId: data.siteId, status: 'queued' }, { status: 'active' }).catch(() => {});
  const proposals = await processGeneration(data.siteId);
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
  // processVideoAd gère elle-même son propre statut (completed/failed/refunded) et le remboursement —
  // on ne relance donc pas le remboursement générique du catch ci-dessous pour ce type de job.
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
  const html = chosen?.htmlDemo;
  if (!html) {
    throw new Error('HTML de la proposition choisie introuvable — impossible de déployer');
  }
  // Toutes les pages du site : l'accueil (html, ci-dessus) + les pages
  // secondaires générées pour les sites multi-pages (voir resolvePagePlan /
  // generateSecondaryPagesForProposal dans ia-pipeline.service.ts). Vide pour
  // un site à page unique — comportement historique inchangé dans ce cas.
  let allPages: { slug: string; title: string; html: string }[] = [
    { slug: 'index', title: 'Accueil', html },
    ...(chosen?.pages || []),
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
      const available = await checkDomainAvailability(data.domainName);
      if (available) {
        await purchaseDomain(data.domainName, 1);
        console.log(`[worker] Domaine acheté: ${data.domainName}`);
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
      await attachDomain(netlifySiteId, data.domainName);
    } catch (err) {
      console.error('[worker] godaddy failed', err);
      throw err;
    }
  } else if (data.domainType === 'byod' && data.domainName) {
    try {
      await attachDomain(netlifySiteId, data.domainName);
    } catch (err) {
      console.warn('[worker] attachDomain BYOD failed — client doit pointer DNS', err);
      // BYOD : le client configure son DNS ; on ne fait pas échouer tout le lancement
    }
  }

  // 4. Provision runtime (MongoDB — remplace l'ancien provisioning Supabase)
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
  site.status = 'launched';
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
      case 'logo':
        console.log('[worker] Logo job — brancher Recraft');
        break;
      case 'repair':
      case 'modification_bloc':
      case 'modification_structurelle':
        console.log(`[worker] ${type} — brancher Réparateur`);
        break;
      default:
        console.warn(`[worker] Type de job inconnu: ${type}`);
    }
  } catch (err) {
    // Remboursement si lancement échoué après débit
    if (type === 'launch_site' && job.data.charges && job.data.userId) {
      try {
        await refundLaunchCharges(job.data.userId, job.data.charges, {
          relatedSiteId: job.data.siteId,
          reason: `remboursement_lancement_echoue:${(err as Error).message?.slice(0, 120)}`,
        });
        console.log(`[worker] Remboursement effectué user=${job.data.userId}`);
      } catch (refundErr) {
        console.error('[worker] Échec remboursement', refundErr);
      }
    }
    await Site.findByIdAndUpdate(job.data.siteId, { status: 'failed' }).catch(() => {});
    await Job.updateOne(
      { siteId: job.data.siteId, status: { $in: ['queued', 'active'] } },
      { status: 'failed', error: (err as Error).message }
    ).catch(() => {});
    throw err;
  }
}

async function main() {
  await connectMongo();

  const worker = new Worker<PipelineJobData>('pipeline', processJob, {
    connection: redisConnection,
    concurrency: 2,
  });

  worker.on('completed', (job) => {
    console.log(`[worker] ✅ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] ❌ Job ${job?.id} failed`, err.message);
  });

  // Pub 4 (Partie commerciale) — scan de relance différée Coach business,
  // toutes les heures. jobId fixe : un seul scheduler répétable, même si le
  // worker redémarre plusieurs fois.
  const remindersWorker = new Worker(
    'reminders',
    async () => {
      const { scanned, sent } = await runStarterConversionReminders();
      console.log(`[worker] Relance Coach business — scanné=${scanned} envoyé=${sent}`);
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

  console.log('🔧 NexAI BullMQ worker démarré (queues: pipeline, reminders)');
}

main().catch((err) => {
  console.error('Worker crash', err);
  process.exit(1);
});
