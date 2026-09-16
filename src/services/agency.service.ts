import { Types } from 'mongoose';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@/models/Client';
import { Site, ISiteProposal } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';
import { deploySite } from '@/services/netlify.service';
import { createZipBuffer } from '@/utils/zip';
import { injectPublicBackendScript } from '@/utils/injectBackend';
import { generatePublicApiKey } from '@/utils/crypto';
import { scaffoldNextjsProject } from '@/services/nextjs-pipeline.service';
import { buildAndDeployNextjsSite } from '@/services/netlify-nextjs.service';
import { env } from '@/config/env';

/**
 * Espace Agence — implémente le contrat déjà posé côté frontend
 * (voir nexai-frontend/lib/api.ts → agencyApi et GUIDE_INTEGRATION.md §4).
 *
 * Édition rapide de texte (quick-edit) — approche retenue :
 * le pipeline de génération (ia-pipeline.service.ts) tague déjà chaque bloc
 * de texte éditable avec un attribut `data-nexai-id` unique dans le HTML
 * stocké sur `Site.proposals[].htmlDemo`. On patche donc directement le
 * texte de ces nœuds dans le HTML déjà généré (aucun nouvel appel IA),
 * puis on redéploie le fichier statique sur Netlify si le site est déjà
 * en ligne. Coût : 0 crédit (CREDIT_COSTS.MODIF_MANUELLE), cohérent avec
 * ce qui est déjà défini dans credits.service.ts.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remplace le contenu texte des nœuds `data-nexai-id="<id>"` dans le HTML.
 * Fonctionne pour les blocs de texte "feuilles" (titres, paragraphes,
 * boutons...) sans enfant du même nom de balise — cas normal pour du
 * copywriting généré. Retourne les ids effectivement trouvés/patchés.
 */
export function patchTextNodes(
  html: string,
  textFields: Record<string, string>
): { html: string; patchedIds: string[]; notFoundIds: string[] } {
  let result = html;
  const patchedIds: string[] = [];
  const notFoundIds: string[] = [];

  for (const [id, rawValue] of Object.entries(textFields)) {
    const pattern = new RegExp(
      `(<([a-zA-Z0-9]+)([^>]*data-nexai-id=["']${escapeRegExp(id)}["'][^>]*)>)([\\s\\S]*?)(<\\/\\2>)`
    );
    if (!pattern.test(result)) {
      notFoundIds.push(id);
      continue;
    }
    const safeValue = escapeHtml(rawValue);
    result = result.replace(pattern, `$1${safeValue}$5`);
    patchedIds.push(id);
  }

  return { html: result, patchedIds, notFoundIds };
}

function serializeClient(
  client: {
    _id: Types.ObjectId;
    nom: string;
    contactEmail?: string;
    contactTelephone?: string;
    notes?: string;
    dernierAcces?: Date;
    createdAt?: Date;
    updatedAt?: Date;
  },
  extra?: { sitesCount?: number; active?: boolean }
) {
  return {
    id: String(client._id),
    name: client.nom,
    nom: client.nom,
    email: client.contactEmail,
    contactEmail: client.contactEmail,
    phone: client.contactTelephone,
    contactTelephone: client.contactTelephone,
    notes: client.notes,
    lastAccess: client.dernierAcces,
    dernierAcces: client.dernierAcces,
    sitesCount: extra?.sitesCount ?? 0,
    active: extra?.active ?? true,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export async function listClients(agencyUserId: string) {
  const clients = await Client.find({ agencyUserId }).sort({ createdAt: -1 });
  const clientIds = clients.map((c) => c._id);
  const counts = await Site.aggregate([
    { $match: { clientId: { $in: clientIds }, userId: new Types.ObjectId(agencyUserId) } },
    { $group: { _id: '$clientId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c: { _id: Types.ObjectId; count: number }) => [String(c._id), c.count]));

  return clients.map((c) =>
    serializeClient(c, {
      sitesCount: countMap.get(String(c._id)) ?? 0,
      active: true,
    })
  );
}

export async function createClient(
  agencyUserId: string,
  data: {
    nom?: string;
    name?: string;
    contactEmail?: string;
    email?: string;
    contactTelephone?: string;
    phone?: string;
    notes?: string;
  }
) {
  const nom = (data.nom || data.name || '').trim();
  if (!nom) throw new AppError('Le nom du client est requis', 400);

  const client = await Client.create({
    agencyUserId,
    nom,
    contactEmail: data.contactEmail || data.email,
    contactTelephone: data.contactTelephone || data.phone,
    notes: data.notes,
  });
  return serializeClient(client, { sitesCount: 0, active: true });
}

export async function getClientWithSites(agencyUserId: string, clientId: string) {
  if (!Types.ObjectId.isValid(clientId)) throw new AppError('Client introuvable', 404);

  const client = await Client.findOne({ _id: clientId, agencyUserId });
  if (!client) throw new AppError('Client introuvable', 404);

  const sites = await Site.find({ clientId: client._id, userId: agencyUserId })
    .select('-proposals.htmlDemo -proposals.pages.html')
    .sort({ updatedAt: -1 });

  return {
    client: serializeClient(client, { sitesCount: sites.length, active: true }),
    sites,
  };
}

/** Stats basiques Espace Agence / Analytics */
export async function getAgencyStats(agencyUserId: string) {
  const uid = new Types.ObjectId(agencyUserId);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [clientsCount, sitesTotal, sitesThisMonth, launchedSites] = await Promise.all([
    Client.countDocuments({ agencyUserId: uid }),
    Site.countDocuments({ userId: uid, clientId: { $exists: true, $ne: null } }),
    Site.countDocuments({
      userId: uid,
      clientId: { $exists: true, $ne: null },
      createdAt: { $gte: startOfMonth },
    }),
    Site.countDocuments({
      userId: uid,
      clientId: { $exists: true, $ne: null },
      status: { $in: ['launched', 'offline'] },
    }),
  ]);

  return {
    clientsCount,
    sitesCount: sitesTotal,
    sitesCreatedThisMonth: sitesThisMonth,
    launchedSites,
    activeClients: clientsCount, // simplification : tous actifs pour l'instant
  };
}

export async function quickEditSite(
  agencyUserId: string,
  siteId: string,
  textFields: Record<string, string>
) {
  if (!Types.ObjectId.isValid(siteId)) throw new AppError('Site introuvable', 404);
  if (!textFields || Object.keys(textFields).length === 0) {
    throw new AppError('Aucun champ à modifier fourni', 400);
  }

  const site = await Site.findOne({ _id: siteId, userId: agencyUserId });
  if (!site) throw new AppError('Site introuvable ou accès refusé', 404);

  const chosen = site.proposals.find((p) => p.versionId === site.chosenProposalId);
  if (!chosen || !chosen.htmlDemo) {
    throw new AppError("Ce site n'a pas encore de contenu généré à éditer", 400);
  }

  // Patch appliqué sur TOUTES les pages du site (accueil + pages secondaires
  // des sites multi-pages, voir PAGES_PAR_NICHE) — un data-nexai-id donné
  // n'existe en pratique que sur UNE page : on tente le patch page par page
  // et on ne garde comme "non trouvé" que ce qui n'a matché nulle part.
  // Comportement identique à avant pour les sites à page unique (chosen.pages vide).
  const remaining: Record<string, string> = { ...textFields };
  const patchedIds: string[] = [];

  const { html: patchedHome, patchedIds: homeIds } = patchTextNodes(chosen.htmlDemo, remaining);
  patchedIds.push(...homeIds);
  homeIds.forEach((id) => delete remaining[id]);

  const updatedPages: NonNullable<ISiteProposal['pages']> = [];
  for (const page of chosen.pages || []) {
    if (Object.keys(remaining).length === 0) {
      updatedPages.push(page);
      continue;
    }
    const { html: patchedPageHtml, patchedIds: pageIds } = patchTextNodes(page.html, remaining);
    updatedPages.push(pageIds.length > 0 ? { ...page, html: patchedPageHtml } : page);
    pageIds.forEach((id) => delete remaining[id]);
    patchedIds.push(...pageIds);
  }
  const notFoundIds = Object.keys(remaining);

  if (patchedIds.length === 0) {
    throw new AppError(
      "Aucun des champs fournis ne correspond à un bloc éditable de ce site (data-nexai-id introuvable).",
      400
    );
  }

  chosen.htmlDemo = patchedHome;
  if (updatedPages.length > 0) chosen.pages = updatedPages;
  site.markModified('proposals');

  // Met à jour dernierAcces du client rattaché, si applicable — n'échoue pas
  // le quick-edit si le site n'est pas rattaché à un client (site perso agence).
  if (site.clientId) {
    await Client.updateOne({ _id: site.clientId }, { dernierAcces: new Date() }).catch(() => {});
  }

  // Redéploiement : uniquement si le site est déjà en ligne sur un vrai
  // site Netlify (pas un stub local de dev). IMPORTANT : on redéploie TOUJOURS
  // l'ensemble des pages du site (pas seulement celle éditée) — un déploiement
  // Netlify remplace tout le contenu publié, donc envoyer uniquement
  // index.html effacerait les autres pages d'un site multi-pages.
  let redeployed = false;
  if (site.netlifySiteId && !site.netlifySiteId.startsWith('local_')) {
    if (!site.publicApiKey) {
      site.publicApiKey = generatePublicApiKey();
    }
    const allPages: { slug: string; title: string; html: string }[] = [
      { slug: 'index', title: 'Accueil', html: chosen.htmlDemo },
      ...(chosen.pages || []),
    ];

    try {
      if (site.siteType === 'nextjs') {
        // Site complexe : on refait un build+déploiement complet du projet
        // Next.js avec le contenu mis à jour (plus lent qu'un site statique,
        // mais nécessaire pour que la modification apparaisse réellement).
        const projectDir = await mkdtemp(path.join(tmpdir(), `nexai-quickedit-${siteId}-`));
        try {
          await scaffoldNextjsProject({
            targetDir: projectDir,
            siteId: String(site._id),
            siteName: site.name || String(site._id),
            pages: allPages,
            publicApiKey: site.publicApiKey,
            publicApiBaseUrl: env.PUBLIC_API_BASE_URL,
          });
          await buildAndDeployNextjsSite({ projectDir, netlifySiteId: site.netlifySiteId });
        } finally {
          await rm(projectDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
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
        await deploySite(site.netlifySiteId, zipBuffer);
      }
      redeployed = true;
    } catch (err) {
      // On ne perd pas la modification enregistrée en base même si le
      // redéploiement échoue momentanément (ex: Netlify indisponible) ;
      // on remonte l'info au frontend pour qu'il puisse réessayer.
      await site.save();
      throw new AppError(
        `Modification enregistrée mais le redéploiement a échoué (${(err as Error).message}). Réessayez.`,
        502
      );
    }
  }

  await site.save();

  return { site, patchedIds, notFoundIds, redeployed };
}
