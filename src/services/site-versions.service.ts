import { Types } from 'mongoose';
import { SiteVersion, TypeChangement } from '@/models/SiteVersion';
import { Site } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';

/**
 * Historique et retour en arrière — Architecture v6, section 10.
 *
 * Les 10 dernières versions sont conservées par site ; au-delà, les plus
 * anciennes sont supprimées automatiquement pour ne pas faire grossir la
 * base indéfiniment (un site multi-pages pèse vite plusieurs centaines de
 * Ko par version).
 */

export const MAX_VERSIONS_CONSERVEES = 10;

/** Extrait le HTML courant du site (proposition retenue ou première dispo). */
function htmlCourant(site: InstanceType<typeof Site>): string | null {
  const props = site.proposals ?? [];
  const retenue = site.chosenProposalId
    ? props.find((p) => p.versionId === site.chosenProposalId)
    : null;
  return (retenue ?? props[0])?.htmlDemo ?? null;
}

/**
 * Enregistre une version AVANT modification. À appeler systématiquement
 * juste avant d'écraser le HTML d'un site, quelle que soit l'origine du
 * changement — c'est ce qui rend la restauration possible.
 *
 * Ne lève jamais d'erreur bloquante : l'échec d'un archivage ne doit pas
 * empêcher le client de modifier son site.
 */
export async function enregistrerVersion(
  siteId: Types.ObjectId | string,
  typeChangement: TypeChangement,
  resume?: string
): Promise<void> {
  try {
    const site = await Site.findById(siteId);
    if (!site) return;

    const html = htmlCourant(site);
    if (!html) return; // rien à archiver (site pas encore généré)

    const dernier = await SiteVersion.findOne({ siteId: site._id })
      .sort({ numero: -1 })
      .select('numero')
      .lean();

    const retenue = site.chosenProposalId
      ? (site.proposals ?? []).find((p) => p.versionId === site.chosenProposalId)
      : (site.proposals ?? [])[0];

    await SiteVersion.create({
      siteId: site._id,
      userId: site.userId,
      numero: (dernier?.numero ?? 0) + 1,
      typeChangement,
      htmlSnapshot: html,
      pagesSnapshot: (retenue?.pages ?? []).map((p) => ({
        slug: p.slug,
        title: p.title,
        html: p.html ?? '',
      })),
      resume,
    });

    // Purge des versions au-delà des 10 plus récentes.
    const trop = await SiteVersion.find({ siteId: site._id })
      .sort({ numero: -1 })
      .skip(MAX_VERSIONS_CONSERVEES)
      .select('_id')
      .lean();
    if (trop.length > 0) {
      await SiteVersion.deleteMany({ _id: { $in: trop.map((v) => v._id) } });
    }
  } catch (err) {
    console.error('[versions] Archivage échoué (non bloquant) :', err);
  }
}

/** Liste l'historique d'un site, du plus récent au plus ancien. */
export async function listerVersions(siteId: Types.ObjectId | string, userId: Types.ObjectId | string) {
  const site = await Site.findById(siteId).select('userId');
  if (!site) throw new AppError('Site introuvable.', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé.', 403);

  const versions = await SiteVersion.find({ siteId })
    .sort({ numero: -1 })
    .limit(MAX_VERSIONS_CONSERVEES)
    .select('numero typeChangement resume createdAt')
    .lean();

  const LIBELLES: Record<TypeChangement, string> = {
    mise_en_ligne: 'Mise en ligne',
    modification_ia: 'Modification IA',
    edition_manuelle: 'Édition manuelle',
    restauration: 'Restauration',
  };

  return versions.map((v, index) => ({
    id: String(v._id),
    numero: v.numero,
    type: v.typeChangement,
    libelle: LIBELLES[v.typeChangement],
    resume: v.resume ?? null,
    date: v.createdAt,
    // La plus récente correspond à l'état actuel : pas de bouton Restaurer.
    estVersionActuelle: index === 0,
  }));
}

/**
 * Restaure une version antérieure.
 *
 * L'état courant est lui-même archivé avant d'être remplacé : une
 * restauration reste réversible, le client ne peut pas se piéger.
 */
export async function restaurerVersion(
  versionId: string,
  userId: Types.ObjectId | string
) {
  const version = await SiteVersion.findById(versionId);
  if (!version) throw new AppError('Version introuvable.', 404);

  const site = await Site.findById(version.siteId);
  if (!site) throw new AppError('Site introuvable.', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé.', 403);

  // Archive l'état actuel AVANT de l'écraser.
  await enregistrerVersion(site._id, 'restauration', `Avant restauration de la version ${version.numero}`);

  const props = site.proposals ?? [];
  const cible = site.chosenProposalId
    ? props.find((p) => p.versionId === site.chosenProposalId)
    : props[0];
  if (!cible) throw new AppError('Aucune proposition à restaurer sur ce site.', 409);

  cible.htmlDemo = version.htmlSnapshot;
  if (version.pagesSnapshot?.length) {
    cible.pages = version.pagesSnapshot.map((p) => ({
      slug: p.slug,
      title: p.title ?? p.slug,
      html: p.html,
    })) as typeof cible.pages;
  }
  site.markModified('proposals');
  await site.save();

  return {
    restauree: version.numero,
    // Le site doit être remis en ligne pour que les visiteurs voient le
    // changement : restaurer modifie l'aperçu, pas la version publiée.
    necessiteRepublication: site.status === 'launched',
  };
}
