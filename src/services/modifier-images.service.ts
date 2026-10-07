import { createHash } from 'crypto';
import type { HydratedDocument } from 'mongoose';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { PhotoStock } from '@/models/PhotoStock';
import type { ISite, ISiteProposal, IPhotoAutorisee } from '@/models/Site';
import { copierImagePourSite } from '@/services/cloudinary.service';
import { searchPexels, type PexelsPhoto } from '@/services/site-image-sourcing.service';
import { estNicheDeSite, requetesDeNiche, lignesCredit } from '@/services/site-photo-stock.service';
import { creditsPhotos } from '@/services/photos-autorisees.service';
import {
  LARGEUR_MIN_PLEIN_ECRAN,
  LARGEUR_MIN_SECTION,
  cadrageAcceptable,
  descriptionSansCliche,
  mesurerNettete,
  partRecadree,
  ratioNumerique,
} from '@/services/photo-qualite.service';
import { enregistrerVersion } from '@/services/site-versions.service';

/**
 * « Modifier les images du site » (décision du 03/10/2026).
 *
 * Le client choisit, pour une ou plusieurs images de son site, une nouvelle
 * image parmi des PROPOSITIONS : la galerie NexAI (stock déjà filtré et
 * stocké sur notre Cloudinary), d'autres propositions trouvées en direct
 * (même filtre de qualité), ou sa propre image. Tout est enregistré en UNE
 * modification. Pour changer encore, il relance « Modifier les images ».
 *
 * GRATUIT : comme pour les textes, une modification n'est visible des
 * visiteurs qu'après une nouvelle mise en ligne, qui elle est payante.
 *
 * Aucun juge IA : seules des images qui passent le filtre de qualité de la
 * galerie (largeur minimale, recadrage ≤ 25 %, clichés, netteté si le seuil
 * est réglé) sont proposées ou acceptées.
 */

const NB_PROPOSITIONS = 12;

export interface ImageDuSite {
  id: string;
  url: string;
  alt: string;
  pages: string[];
  ratio: string;
  emplacement?: string;
  source?: IPhotoAutorisee['source'];
  largeurMin: number;
}

export interface PropositionImage {
  /** Référence à renvoyer pour appliquer ce choix : stock:<id> | pexels:<id> | client:<url>. */
  ref: string;
  apercu: string;
  largeur?: number;
  hauteur?: number;
  credit?: string;
}

function idImage(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

/** Proposition retenue du site (un seul aperçu depuis le 02/10/2026). */
export function propositionDuSite(site: Pick<ISite, 'proposals' | 'chosenProposalId'>): ISiteProposal | undefined {
  const props = site.proposals ?? [];
  return props.find((p) => p.versionId === site.chosenProposalId) ?? props[0];
}

function pagesDe(prop: ISiteProposal): { slug: string; html: string }[] {
  return [
    { slug: 'index', html: prop.htmlDemo ?? '' },
    ...(prop.pages ?? []).map((p) => ({ slug: p.slug, html: p.html ?? '' })),
  ].filter((p) => p.html);
}

/** Adresses d'images d'une page : balises <img> et fonds CSS (style en ligne ou bloc <style>). */
function adressesImages(html: string): { url: string; alt: string }[] {
  const sortie: { url: string; alt: string }[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc=(["'])(https:\/\/[^"']+)\1/i)?.[2];
    if (!src) continue;
    const alt = tag.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? '';
    sortie.push({ url: src, alt });
  }
  for (const m of html.matchAll(/url\(\s*(["']?)(https:\/\/[^"')]+)\1\s*\)/gi)) {
    sortie.push({ url: m[2], alt: '' });
  }
  return sortie;
}

/** Le logo n'est pas une image modifiable ici (il a son propre parcours). */
function estLogo(url: string, alt: string, logoUrl?: string): boolean {
  return (!!logoUrl && url === logoUrl) || /\blogo\b/i.test(alt) || /\/logos?\//i.test(url);
}

/** Ratio d'un emplacement d'après ses dimensions, ramené aux formats usuels. */
function ratioDepuisDimensions(w?: number, h?: number): string {
  if (!w || !h) return '16:9';
  const r = w / h;
  const formats: [string, number][] = [
    ['16:9', 16 / 9], ['3:2', 1.5], ['4:3', 4 / 3], ['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['2:3', 2 / 3], ['9:16', 9 / 16],
  ];
  return formats.reduce((meilleur, f) => (Math.abs(f[1] - r) < Math.abs(meilleur[1] - r) ? f : meilleur))[0];
}

export function listerImagesDuSite(site: HydratedDocument<ISite>): ImageDuSite[] {
  const prop = propositionDuSite(site);
  if (!prop) return [];
  const autorisees = prop.photosAutorisees ?? [];
  const pleinEcran = prop.combinaison?.hero === 'fullbleed';
  const parUrl = new Map<string, ImageDuSite>();
  for (const page of pagesDe(prop)) {
    for (const { url, alt } of adressesImages(page.html)) {
      if (estLogo(url, alt, site.chosenLogoUrl)) continue;
      const deja = parUrl.get(url);
      if (deja) {
        if (!deja.pages.includes(page.slug)) deja.pages.push(page.slug);
        if (!deja.alt && alt) deja.alt = alt;
        continue;
      }
      const connue = autorisees.find((p) => p.url === url);
      const estHero = connue?.slot === 'hero';
      parUrl.set(url, {
        id: idImage(url),
        url,
        alt,
        pages: [page.slug],
        ratio: connue?.ratio ?? ratioDepuisDimensions(connue?.width, connue?.height),
        emplacement: connue?.label ?? connue?.slot,
        source: connue?.source,
        largeurMin: estHero && pleinEcran ? LARGEUR_MIN_PLEIN_ECRAN : LARGEUR_MIN_SECTION,
      });
    }
  }
  return Array.from(parUrl.values());
}

function trouverImage(site: HydratedDocument<ISite>, imageId: string): ImageDuSite {
  const image = listerImagesDuSite(site).find((i) => i.id === imageId);
  if (!image) throw new AppError('Cette image ne fait plus partie de votre site. Rechargez la page.', 404);
  return image;
}

function orientationDe(ratio: string): 'landscape' | 'portrait' {
  const r = ratioNumerique(ratio) ?? 16 / 9;
  return r >= 1 ? 'landscape' : 'portrait';
}

/** Petite vignette Cloudinary pour l'écran de choix (rapide sur téléphone). */
function vignette(url: string): string {
  return url.replace(/\/upload\/(?:[^/]*\/)?/, '/upload/f_auto,q_auto,w_600/');
}

function photoAcceptable(p: PexelsPhoto, image: ImageDuSite): boolean {
  return (
    !!p.id &&
    (p.width ?? 0) >= image.largeurMin &&
    cadrageAcceptable(p.width, p.height, image.ratio) &&
    descriptionSansCliche(p.alt)
  );
}

/**
 * Propositions pour UNE image : galerie NexAI d'abord ; « plus de
 * propositions » = recherche en direct (même filtre), éventuellement avec
 * les mots du client.
 */
export async function propositionsPourImage(
  site: HydratedDocument<ISite>,
  imageId: string,
  opts: { source: 'galerie' | 'direct'; recherche?: string }
): Promise<PropositionImage[]> {
  const image = trouverImage(site, imageId);
  const cible = ratioNumerique(image.ratio);

  if (opts.source === 'galerie') {
    if (!estNicheDeSite(site.niche)) return [];
    const candidates = await PhotoStock.find({ niche: site.niche, statut: 'disponible', width: { $gte: image.largeurMin } })
      .select('_id url width height photographer')
      .limit(400)
      .lean();
    return candidates
      .filter((c) => cadrageAcceptable(c.width, c.height, image.ratio))
      .map((c) => ({ c, note: Math.random() + (cible && c.width && c.height ? partRecadree(c.width, c.height, cible) * 2 : 0) }))
      .sort((a, b) => a.note - b.note)
      .slice(0, NB_PROPOSITIONS)
      .map(({ c }) => ({
        ref: `stock:${String(c._id)}`,
        apercu: vignette(c.url),
        largeur: c.width,
        hauteur: c.height,
        credit: c.photographer,
      }));
  }

  const requetes = estNicheDeSite(site.niche) ? requetesDeNiche(site.niche, orientationDe(image.ratio)) : [];
  const recherche = (opts.recherche ?? '').trim().slice(0, 80);
  const requete = recherche || requetes[Math.floor(Math.random() * Math.max(1, requetes.length))] || site.niche.replace(/_/g, ' ');
  const trouvees = await searchPexels(requete, orientationDe(image.ratio), 60);
  let retenues = trouvees.filter((p) => photoAcceptable(p, image));
  if (env.PHOTO_NETTETE_MIN > 0 && retenues.length > 0) {
    const net = await mesurerNettete(retenues.slice(0, 24).map((p) => p.src.large));
    retenues = retenues.filter((p) => {
      const v = net.get(p.src.large);
      return v === undefined || v >= env.PHOTO_NETTETE_MIN;
    });
  }
  return retenues.slice(0, NB_PROPOSITIONS).map((p) => ({
    ref: `pexels:${p.id}`,
    apercu: p.src.large,
    largeur: p.width,
    hauteur: p.height,
    credit: p.photographer,
  }));
}

async function photoPexelsParId(id: number): Promise<PexelsPhoto | null> {
  if (!env.PEXELS_API_KEY) throw new AppError('Les propositions supplémentaires sont momentanément indisponibles.', 503);
  const res = await fetch(`https://api.pexels.com/v1/photos/${id}`, { headers: { Authorization: env.PEXELS_API_KEY } });
  if (!res.ok) return null;
  return (await res.json()) as PexelsPhoto;
}

/** Contrôle de qualité d'une image envoyée par le client (même exigence que la galerie). */
export function controlerImageClient(
  site: HydratedDocument<ISite>,
  imageId: string,
  dims: { width: number; height: number }
): { ok: true } | { ok: false; raison: string } {
  const image = trouverImage(site, imageId);
  if (dims.width < image.largeurMin) {
    return {
      ok: false,
      raison: `Image trop petite (${dims.width} px de large) : il faut au moins ${image.largeurMin} px pour rester nette sur votre site.`,
    };
  }
  if (!cadrageAcceptable(dims.width, dims.height, image.ratio)) {
    return {
      ok: false,
      raison: `Format trop différent de l'emplacement (${image.ratio}) : l'image serait trop coupée. Choisissez une image ${orientationDe(image.ratio) === 'portrait' ? 'verticale' : 'horizontale'}.`,
    };
  }
  return { ok: true };
}

function echapperRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remplace une adresse d'image partout dans une page ; retire srcset/sizes des <img> concernées. */
function remplacerDansPage(html: string, ancienne: string, nouvelle: string): string {
  let sortie = html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.includes(ancienne) ? tag.replace(/\s+(?:srcset|sizes)=(["'])[^"']*\1/gi, '') : tag
  );
  sortie = sortie.replace(new RegExp(echapperRegex(ancienne), 'g'), () => nouvelle);
  return sortie;
}

/** Ligne de crédit des photos de la galerie, recalculée après un changement. */
function reposerCredits(html: string, photos: IPhotoAutorisee[]): string {
  const sans = html.replace(/<p\b[^>]*data-nexai-id=(["'])credit-photos\1[^>]*>[\s\S]*?<\/p>/gi, '');
  const credits = creditsPhotos(photos);
  if (credits.length === 0) return sans;
  const ligne = `<p data-nexai-id="credit-photos" style="font-size:.8125rem;margin:.5rem auto 0;padding:0 1rem 1rem;max-width:1200px;text-align:center;color:var(--muted,inherit)">${lignesCredit(credits)}</p>`;
  return /<\/footer>/i.test(sans) ? sans.replace(/<\/footer>/i, () => `${ligne}</footer>`) : sans.replace(/<\/body>/i, () => `${ligne}</body>`);
}

export interface RemplacementDemande {
  imageId: string;
  ref: string;
}

/**
 * Applique en UNE modification tous les remplacements choisis par le client.
 * Toutes les images sont d'abord obtenues et contrôlées ; le site n'est
 * modifié que si toutes sont valides (jamais de modification à moitié faite).
 */
export async function appliquerRemplacements(
  site: HydratedDocument<ISite>,
  remplacements: RemplacementDemande[]
): Promise<{ remplacees: number }> {
  const prop = propositionDuSite(site);
  if (!prop) throw new AppError("Ce site n'a pas encore d'images à modifier.", 400);
  const images = listerImagesDuSite(site);
  const uniques = Array.from(new Map(remplacements.map((r) => [r.imageId, r])).values());
  if (uniques.length === 0) throw new AppError('Choisissez au moins une nouvelle image.', 400);

  const nouvelles: { image: ImageDuSite; photo: IPhotoAutorisee; stockId?: string }[] = [];
  const stockPris: string[] = [];
  try {
    for (const r of uniques) {
      const image = images.find((i) => i.id === r.imageId);
      if (!image) throw new AppError('Une des images ne fait plus partie de votre site. Rechargez la page.', 404);
      const base = { slot: undefined as string | undefined, ratio: image.ratio, label: image.emplacement };
      const connue = (prop.photosAutorisees ?? []).find((p) => p.url === image.url);
      base.slot = connue?.slot;

      if (r.ref.startsWith('stock:')) {
        const id = r.ref.slice(6);
        // Attribution atomique : une photo de la galerie n'est jamais donnée à deux sites.
        const p = await PhotoStock.findOneAndUpdate(
          { _id: id, statut: 'disponible', niche: site.niche },
          { $set: { statut: 'attribuee', attribueeLe: new Date(), siteId: site._id } },
          { new: true }
        ).lean();
        if (!p) throw new AppError("Une des images choisies vient d'être prise. Choisissez-en une autre.", 409);
        stockPris.push(String(p._id));
        if ((p.width ?? 0) < image.largeurMin || !cadrageAcceptable(p.width, p.height, image.ratio)) {
          throw new AppError("Une des images choisies ne convient pas à cet emplacement. Choisissez-en une autre.", 400);
        }
        nouvelles.push({
          image,
          stockId: String(p._id),
          photo: { ...base, url: p.url, source: 'galerie', width: p.width, height: p.height, photographer: p.photographer, pexelsUrl: p.pexelsUrl },
        });
      } else if (r.ref.startsWith('pexels:')) {
        const id = Number(r.ref.slice(7));
        const p = Number.isInteger(id) ? await photoPexelsParId(id) : null;
        if (!p || !photoAcceptable(p, image)) {
          throw new AppError("Une des images choisies n'est plus disponible ou ne convient pas. Choisissez-en une autre.", 400);
        }
        // Copie sur le Cloudinary NexAI : le site ne dépend jamais d'un lien externe.
        const copie = await copierImagePourSite(p.src.original || p.src.large2x, String(site._id), `modif-${p.id}`);
        nouvelles.push({
          image,
          photo: { ...base, url: copie.url, source: 'galerie', width: p.width, height: p.height, photographer: p.photographer, pexelsUrl: p.url },
        });
      } else if (r.ref.startsWith('client:')) {
        const url = r.ref.slice(7);
        // Seulement une image déjà envoyée et contrôlée pour CE site (dossier Cloudinary du site).
        const attendu = new RegExp(`^https://res\\.cloudinary\\.com/[^/]+/image/upload/.*nexai/sites/${String(site._id)}/client/`);
        if (!attendu.test(url)) throw new AppError('Image envoyée non reconnue. Envoyez-la de nouveau.', 400);
        nouvelles.push({ image, photo: { ...base, url, source: 'client' } });
      } else {
        throw new AppError('Choix d’image non reconnu.', 400);
      }
    }
  } catch (err) {
    // Rien n'est modifié : les photos de la galerie réservées retournent dans le stock.
    if (stockPris.length) {
      await PhotoStock.updateMany(
        { _id: { $in: stockPris } },
        { $set: { statut: 'disponible' }, $unset: { siteId: 1, attribueeLe: 1 } }
      ).catch(() => undefined);
    }
    throw err;
  }

  // Version de sauvegarde AVANT la modification (retour en arrière possible).
  await enregistrerVersion(site._id, 'modification_images', `${nouvelles.length} image(s) remplacée(s)`);

  // Les anciennes photos restent dans la liste (une restauration de version
  // les remet dans la page avec leur crédit) ; les nouvelles s'ajoutent.
  const photos = [...(prop.photosAutorisees ?? [])];
  for (const n of nouvelles) if (!photos.some((p) => p.url === n.photo.url)) photos.push(n.photo);

  const remplacees = (prop.pages ?? []).map((p) => ({ p, html: p.html ?? '' }));
  let accueil = prop.htmlDemo ?? '';
  for (const n of nouvelles) {
    accueil = remplacerDansPage(accueil, n.image.url, n.photo.url);
    for (const r of remplacees) r.html = remplacerDansPage(r.html, n.image.url, n.photo.url);
  }
  // Crédit : seulement les photos réellement présentes dans le site après le changement.
  const toutLeSite = [accueil, ...remplacees.map((r) => r.html)].join('\n');
  const presentes = photos.filter((p) => toutLeSite.includes(p.url));
  prop.htmlDemo = reposerCredits(accueil, presentes);
  for (const r of remplacees) r.p.html = reposerCredits(r.html, presentes);
  prop.photosAutorisees = photos;
  site.markModified('proposals');
  await site.save();
  return { remplacees: nouvelles.length };
}
