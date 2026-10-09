import { v2 as cloudinary } from 'cloudinary';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { Site } from '@/models/Site';
import { SiteVersion } from '@/models/SiteVersion';
import { SiteRuntime } from '@/models/SiteRuntime';
import { PhotoStock } from '@/models/PhotoStock';

/**
 * Nettoyage Cloudinary : supprime les images de SITES qui ne servent plus.
 *
 * Périmètre volontairement étroit : seul le dossier « nexai/sites/ » est
 * examiné (images copiées pour un site : photos de la galerie Pexels, image
 * avec logo, images envoyées par le client). Académie, Boutique, vidéos,
 * logos et galerie NexAI ne sont jamais touchés.
 *
 * Une image est obsolète quand :
 *   - son site n'existe plus, ou
 *   - elle n'apparaît nulle part dans le site : ni dans ses photos, ni dans
 *     ses propositions, ni dans la version en ligne, ni dans l'historique
 *     des versions (qu'on peut restaurer).
 * Les images de moins de 3 jours (7 jours pour celles envoyées par le
 * client) sont toujours gardées : une création ou une modification peut
 * être en cours.
 */

const PREFIXE = 'nexai/sites/';
const AGE_MIN_MS = 3 * 24 * 3600_000;
const AGE_MIN_CLIENT_MS = 7 * 24 * 3600_000;
const MAX_PAGES = 40; // 40 × 500 = 20 000 images examinées au plus par analyse

type Ressource = { public_id: string; bytes: number; created_at: string; secure_url: string };

function configurer() {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError('Cloudinary non configuré', 503);
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

async function toutesLesImagesDeSites(): Promise<{ ressources: Ressource[]; complet: boolean }> {
  const ressources: Ressource[] = [];
  let curseur: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'image',
      prefix: PREFIXE,
      max_results: 500,
      ...(curseur ? { next_cursor: curseur } : {}),
    })) as { resources: Ressource[]; next_cursor?: string };
    ressources.push(...r.resources);
    curseur = r.next_cursor;
    if (!curseur) return { ressources, complet: true };
  }
  return { ressources, complet: false };
}

/** Tout ce qui, pour un site, peut citer une image : site, version en ligne, historique, galerie. */
async function texteDeReference(siteId: string): Promise<string | null> {
  const site = await Site.findById(siteId).lean().catch(() => null);
  if (!site) return null;
  const [versions, runtime, stock] = await Promise.all([
    SiteVersion.find({ siteId }).select('htmlSnapshot pagesSnapshot').lean(),
    SiteRuntime.findOne({ siteId }).lean(),
    PhotoStock.find({ siteId }).select('url').lean(),
  ]);
  return JSON.stringify([site, versions, runtime, stock]);
}

export async function analyserImagesObsoletes() {
  configurer();
  const { ressources, complet } = await toutesLesImagesDeSites();
  const parSite = new Map<string, Ressource[]>();
  for (const r of ressources) {
    const id = r.public_id.slice(PREFIXE.length).split('/')[0];
    if (!/^[0-9a-f]{24}$/i.test(id)) continue; // dossier inattendu : on n'y touche pas
    if (!parSite.has(id)) parSite.set(id, []);
    parSite.get(id)!.push(r);
  }

  const obsoletes: (Ressource & { raison: string })[] = [];
  const maintenant = Date.now();
  for (const [siteId, images] of parSite) {
    const reference = await texteDeReference(siteId);
    for (const img of images) {
      const age = maintenant - new Date(img.created_at).getTime();
      const envoyeeParClient = img.public_id.includes('/client/');
      if (age < (envoyeeParClient ? AGE_MIN_CLIENT_MS : AGE_MIN_MS)) continue;
      if (reference === null) obsoletes.push({ ...img, raison: 'site supprimé' });
      else if (!reference.includes(img.public_id)) obsoletes.push({ ...img, raison: 'plus utilisée dans le site' });
    }
  }

  return {
    examinees: ressources.length,
    analyseComplete: complet,
    nombre: obsoletes.length,
    octets: obsoletes.reduce((t, r) => t + (r.bytes || 0), 0),
    exemples: obsoletes.slice(0, 12).map((r) => ({ url: r.secure_url, raison: r.raison, octets: r.bytes })),
    publicIds: obsoletes.map((r) => r.public_id),
  };
}

/** Recalcule la liste au moment de supprimer : on ne supprime jamais sur la foi d'une ancienne analyse. */
export async function supprimerImagesObsoletes() {
  const analyse = await analyserImagesObsoletes();
  let supprimees = 0;
  for (let i = 0; i < analyse.publicIds.length; i += 100) {
    const lot = analyse.publicIds.slice(i, i + 100);
    const r = (await cloudinary.api.delete_resources(lot, { type: 'upload', resource_type: 'image' })) as {
      deleted?: Record<string, string>;
    };
    supprimees += Object.values(r.deleted ?? {}).filter((v) => v === 'deleted').length;
  }
  return { supprimees, octetsLiberes: analyse.octets, analyseComplete: analyse.analyseComplete };
}

/** Supprime tout de suite une copie qui vient d'être refusée (ex. image avec logo non retenue). */
export async function supprimerImage(publicId: string) {
  try {
    configurer();
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (err) {
    console.warn('[cloudinary] Suppression de l’image refusée impossible (le nettoyage admin la rattrapera)', err);
  }
}
