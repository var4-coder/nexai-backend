import { PhotoStock } from '@/models/PhotoStock';
import { uploadStockPhoto } from '@/services/cloudinary.service';
import { searchPexels } from '@/services/site-image-sourcing.service';
import { verifyImageUrl } from '@/utils/verifyMedia';
import type { SiteNiche } from '@/models/Site';
import { env } from '@/config/env';
import {
  cadrageAcceptable,
  descriptionSansCliche,
  luminanceHex,
  mesurerNettete,
  partRecadree,
  ratioNumerique,
} from '@/services/photo-qualite.service';

/** 50 photos disponibles par niche ; quand il en reste moins de 20, on recharge jusqu'à 50. */
export const STOCK_CIBLE = 50;
export const STOCK_SEUIL = 20;
const LARGEUR_MIN = 1600;

/** Requêtes de recherche par niche (anglais, Pexels indexe en anglais). Varient pour éviter les doublons. */
const REQUETES: Record<SiteNiche, string[]> = {
  restaurant_gastronomie: ['african restaurant dinner', 'fine dining plated dish', 'restaurant interior warm light', 'chef cooking kitchen'],
  hotellerie_evenementiel: ['boutique hotel room', 'hotel terrace sunset', 'wedding venue decor', 'resort pool tropical'],
  sante_bienetre: ['modern clinic reception', 'doctor consultation', 'spa wellness massage', 'yoga studio calm'],
  immobilier_architecture: ['modern tropical house architecture', 'architect drawing plans', 'luxury villa exterior', 'interior design living room'],
  services_locaux: ['plumber at work', 'electrician repair home', 'cleaning service home', 'craftsman workshop'],
  business_vitrine: ['business meeting office', 'consultant presenting team', 'modern office workspace', 'accountant desk documents'],
  ecommerce_mode: ['fashion editorial african model', 'clothing boutique rack', 'tailor atelier fabric', 'streetwear lookbook'],
  portfolio_creatif: ['creative studio workspace', 'photographer at work', 'graphic designer desk', 'art direction moodboard'],
  tech_startup_saas: ['mobile payment shop', 'startup team laptop', 'developer working code', 'dashboard on screen'],
  education_formation: ['students classroom learning', 'film set camera crew', 'workshop training group', 'teacher whiteboard'],
};

export function estNicheDeSite(niche: string): niche is SiteNiche {
  return Object.prototype.hasOwnProperty.call(REQUETES, niche);
}

/**
 * Part de photos VERTICALES dans le stock d'un métier (le reste est en
 * paysage). Seuls les métiers dont la Librairie prévoit un emplacement
 * vertical en ont besoin : « Plat » du restaurant (4:5), « Pièce » de la
 * mode (3:4). Sans elles, ces emplacements partaient en recherche directe.
 */
const PORTRAIT_CIBLE: Partial<Record<SiteNiche, number>> = {
  restaurant_gastronomie: 15,
  ecommerce_mode: 15,
};

/** Requêtes pour les photos verticales (plats, pièces portées). */
const REQUETES_PORTRAIT: Partial<Record<SiteNiche, string[]>> = {
  restaurant_gastronomie: ['plated dish close up', 'african food plate', 'gourmet dish overhead', 'chef plating food'],
  ecommerce_mode: ['african fashion model portrait', 'fashion editorial full body', 'clothing detail portrait', 'model wearing dress studio'],
};

type Orientation = 'paysage' | 'portrait';

/** Requêtes de recherche d'une niche pour une orientation (propositions « Modifier les images »). */
export function requetesDeNiche(niche: SiteNiche, orientation: 'landscape' | 'portrait'): string[] {
  return orientation === 'portrait' ? REQUETES_PORTRAIT[niche] ?? REQUETES[niche] : REQUETES[niche];
}

const rechargesEnCours = new Set<string>();

function filtreOrientation(o: Orientation) {
  // Les photos enregistrées avant cette version n'ont pas d'orientation : ce sont des paysages.
  return o === 'portrait' ? { orientation: 'portrait' } : { orientation: { $ne: 'portrait' } };
}

/** Nombre de photos disponibles pour une niche (toutes orientations, ou une seule). */
export async function nbDisponibles(niche: SiteNiche, orientation?: Orientation): Promise<number> {
  return PhotoStock.countDocuments({ niche, statut: 'disponible', ...(orientation ? filtreOrientation(orientation) : {}) });
}

/** Recharge UNE orientation d'une niche jusqu'à sa cible. */
async function rechargerOrientation(niche: SiteNiche, orientation: Orientation, cible: number): Promise<number> {
  let dispo = await nbDisponibles(niche, orientation);
  if (dispo >= Math.ceil(cible * 0.4)) return 0;
  const requetes = (orientation === 'portrait' ? REQUETES_PORTRAIT[niche] : REQUETES[niche]) ?? REQUETES[niche];
  let ajoutees = 0;
  // Démarre sur une requête différente à chaque recharge (rotation) pour varier les photos.
  const depart = (await PhotoStock.countDocuments({ niche, ...filtreOrientation(orientation) })) % requetes.length;
  for (let k = 0; k < requetes.length && dispo < cible; k++) {
    const q = requetes[(depart + k) % requetes.length];
    const photos = await searchPexels(q, orientation === 'portrait' ? 'portrait' : 'landscape', 80);
    const connus = new Set((await PhotoStock.find({ pexelsId: { $in: photos.map((p) => p.id) } }, 'pexelsId').lean()).map((x) => x.pexelsId));
    // Filtre de qualité MEDIA.md : taille, orientation, clichés de banque d'images, netteté.
    const retenues = photos.filter(
      (p) =>
        p.id &&
        !connus.has(p.id) &&
        (p.width ?? 0) >= LARGEUR_MIN &&
        (orientation === 'portrait' ? (p.height ?? 0) > (p.width ?? 0) : (p.width ?? 0) >= (p.height ?? 0)) &&
        descriptionSansCliche(p.alt)
    );
    const nettete = await mesurerNettete(retenues.map((p) => p.src.large));
    for (const p of retenues) {
      if (dispo >= cible) break;
      const net = nettete.get(p.src.large);
      if (!p.id) continue;
      if (env.PHOTO_NETTETE_MIN > 0 && net !== undefined && net < env.PHOTO_NETTETE_MIN) continue;
      const source = p.src.large2x || p.src.large;
      if (!(await verifyImageUrl(source))) continue;
      try {
        // Copie dans le Cloudinary NexAI : le site ne dépend jamais de Pexels.
        const up = await uploadStockPhoto(p.src.original || source, niche, p.id);
        await PhotoStock.create({
          niche, pexelsId: p.id, url: up.url, publicId: up.publicId, photographer: p.photographer,
          pexelsUrl: p.url, width: p.width, height: p.height, requete: q, statut: 'disponible',
          orientation, alt: p.alt, avgColor: p.avg_color, photographerId: p.photographer_id,
          ...(net !== undefined ? { nettete: net } : {}),
        });
        dispo++; ajoutees++;
      } catch (err) {
        console.warn(`[photo-stock] ${niche} photo ${p.id} ignorée`, (err as Error)?.message);
      }
    }
  }
  return ajoutees;
}

/**
 * Recharge le stock d'une niche : STOCK_CIBLE photos au total, dont
 * PORTRAIT_CIBLE verticales pour les métiers qui en ont besoin. Une
 * orientation est rechargée quand il lui reste moins de 40 % de sa cible.
 * Idempotent et protégé contre les recharges simultanées d'une même niche.
 */
export async function assurerStock(niche: SiteNiche): Promise<{ ajoutees: number; disponibles: number }> {
  if (rechargesEnCours.has(niche)) return { ajoutees: 0, disponibles: await nbDisponibles(niche) };
  rechargesEnCours.add(niche);
  try {
    const portrait = PORTRAIT_CIBLE[niche] ?? 0;
    let ajoutees = await rechargerOrientation(niche, 'paysage', STOCK_CIBLE - portrait);
    if (portrait > 0) ajoutees += await rechargerOrientation(niche, 'portrait', portrait);
    return { ajoutees, disponibles: await nbDisponibles(niche) };
  } finally {
    rechargesEnCours.delete(niche);
  }
}

/**
 * Attribue une photo disponible de la niche (attribution atomique : jamais deux fois la même photo) et
 * déclenche en arrière-plan la recharge si le stock passe sous le seuil. Renvoie null si le stock est vide
 * (l'appelant retombe alors sur la recherche Pexels en direct).
 */
export async function prendreDuStock(
  niche: SiteNiche,
  siteId?: string
): Promise<{ url: string; photographer: string; pexelsUrl: string } | null> {
  const n = await nbDisponibles(niche, 'paysage');
  const saut = n > 1 ? Math.floor(Math.random() * n) : 0;
  const cible = await PhotoStock.findOne({ niche, statut: 'disponible', ...filtreOrientation('paysage') }).skip(saut).select('_id').lean();
  const p = cible
    ? await PhotoStock.findOneAndUpdate(
        { _id: cible._id, statut: 'disponible' },
        { $set: { statut: 'attribuee', attribueeLe: new Date(), ...(siteId ? { siteId } : {}) } },
        { new: true }
      ).lean()
    : null;
  if (n - 1 < Math.ceil((STOCK_CIBLE - (PORTRAIT_CIBLE[niche] ?? 0)) * 0.4)) void assurerStock(niche).catch((e) => console.warn('[photo-stock] recharge échouée', e?.message));
  return p ? { url: p.url, photographer: p.photographer, pexelsUrl: p.pexelsUrl } : null;
}

/** Crédit photo à insérer dans le site livré (lien Pexels visible + photographe). */
export function lignesCredit(credits: Array<{ photographer: string; pexelsUrl: string }>): string {
  const uniques = Array.from(new Map(credits.map((c) => [c.photographer, c])).values());
  const noms = uniques.map((c) => c.photographer).filter(Boolean).join(', ');
  return `Photos : ${noms ? noms + ' — ' : ''}<a href="https://www.pexels.com" target="_blank" rel="noopener noreferrer">Pexels</a>`;
}

export interface PhotoDuStock {
  url: string;
  photographer: string;
  pexelsUrl: string;
  width?: number;
  height?: number;
  photographerId?: number;
}

/**
 * Attribue une photo de la galerie adaptée à un EMPLACEMENT (MEDIA.md) :
 * largeur minimale (2 400 px en plein écran), recadrage ≤ 25 % pour le ratio
 * de l'emplacement, et cohérence de la série (même photographe que les
 * photos déjà retenues pour le site si possible ; photos sombres pour une
 * famille sombre). Attribution atomique : une photo de la galerie n'est
 * jamais donnée à deux sites (anti-clone). Renvoie null si aucune ne convient.
 */
export async function prendreDuStockPourEmplacement(
  niche: SiteNiche,
  opts: { ratio?: string; largeurMin?: number; siteId?: string; photographeIds?: number[]; sombre?: boolean }
): Promise<PhotoDuStock | null> {
  const largeurMin = Math.max(opts.largeurMin ?? LARGEUR_MIN, LARGEUR_MIN);
  const candidates = await PhotoStock.find({ niche, statut: 'disponible', width: { $gte: largeurMin } })
    .select('_id width height photographerId avgColor')
    .limit(300)
    .lean();
  const cible = ratioNumerique(opts.ratio);
  const memes = new Set(opts.photographeIds ?? []);
  const classees = candidates
    .filter((c) => cadrageAcceptable(c.width, c.height, opts.ratio))
    .map((c) => {
      let note = Math.random();
      if (cible && c.width && c.height) note += partRecadree(c.width, c.height, cible) * 2;
      if (c.photographerId && memes.has(c.photographerId)) note -= 2;
      const lum = luminanceHex(c.avgColor);
      if (lum !== null) note += opts.sombre ? lum : 0;
      return { id: c._id, note };
    })
    .sort((a, b) => a.note - b.note);

  let trouvee: PhotoDuStock | null = null;
  for (const c of classees.slice(0, 10)) {
    const p = await PhotoStock.findOneAndUpdate(
      { _id: c.id, statut: 'disponible' },
      { $set: { statut: 'attribuee', attribueeLe: new Date(), ...(opts.siteId ? { siteId: opts.siteId } : {}) } },
      { new: true }
    ).lean();
    if (p) {
      trouvee = {
        url: p.url,
        photographer: p.photographer,
        pexelsUrl: p.pexelsUrl,
        width: p.width,
        height: p.height,
        photographerId: p.photographerId,
      };
      break;
    }
  }
  // assurerStock ne recharge que l'orientation qui en a besoin.
  void assurerStock(niche).catch((e) => console.warn('[photo-stock] recharge échouée', e?.message));
  return trouvee;
}
