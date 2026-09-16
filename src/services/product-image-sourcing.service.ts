import { AppError } from '@/middleware/errorHandler';
import { verifyImageUrl } from '@/utils/verifyMedia';
import { sourceMockupImage } from '@/services/site-image-sourcing.service';
import { Site, ISite } from '@/models/Site';

/**
 * Pool d'images de référence pour les plans "IA" (Grok Imagine image-to-image)
 * d'une vidéo pub. Mélange volontaire de deux natures d'images, jamais
 * confondues :
 *
 * - 'product' : photo RÉELLE (produit/service du client) — soit extraite
 *   automatiquement du vrai site, soit ajoutée à la main par le client à
 *   l'étape de brief. Sert à ancrer les plans "démonstration/bénéfice" dans
 *   la réalité du client plutôt que de tout laisser halluciner à l'IA.
 * - 'mockup' : photo stock (Pexels) pour "embellir" les plans d'ambiance/
 *   émotion qui n'ont pas besoin d'être une photo du produit exact.
 *
 * Règle de non-redondance (décision produit) : si le site est un site NexAI
 * (videoAd.siteId défini) et que sa proposition retenue a déjà des
 * ambianceImages sourcées Pexels (imageStyle === 'mockup'), on les RÉUTILISE
 * telles quelles — aucun nouvel appel Pexels. On n'interroge Pexels à
 * nouveau que si le site est externe (pas de siteId, juste une URL fournie
 * par le client) ou si le site NexAI n'a pas de mockups déjà générés
 * (imageStyle === 'realiste').
 *
 * Best-effort total, comme le reste du pipeline vidéo : chaque source peut
 * échouer indépendamment sans jamais faire échouer la génération de la
 * vidéo — au pire le pool retourné est plus petit (voire vide), et
 * video-pipeline.service.ts retombe sur la génération 100% text-to-image
 * comme avant cette fonctionnalité.
 */

export type ReferenceImageKind = 'product' | 'mockup';

export interface ReferenceImage {
  url: string;
  kind: ReferenceImageKind;
  source: 'site_scrape' | 'client_upload' | 'nexai_reuse' | 'pexels_fresh';
}

export interface ReferenceImagePool {
  productImages: ReferenceImage[];
  mockupImages: ReferenceImage[];
}

const MAX_PRODUCT_IMAGES_FROM_SITE = 6;
const MAX_MOCKUP_IMAGES = 4;

/**
 * Extrait des candidats "image produit" depuis le HTML brut d'une page
 * (fetch léger, même approche que site-meta.service.ts — pas de navigateur
 * headless ici : on privilégie la rapidité, la plupart des sites e-commerce
 * exposent déjà leurs images produit dans le HTML initial ou en attribut
 * data-src/srcset même en lazy-load).
 *
 * Heuristique volontairement prudente : on exclut tout ce qui ressemble à un
 * logo/icône/tracker, on privilégie les <img> avec des indices "produit"
 * (class/alt/data-* contenant product/produit/item/shop), et on limite le
 * nombre de candidats retournés pour ne pas envoyer 40 images à vérifier.
 */
function extractCandidateImageUrls(html: string, baseUrl: string): string[] {
  const candidates = new Set<string>();

  // Toutes les balises <img> avec src, data-src ou premier item d'un srcset.
  const imgTagRe = /<img\b[^>]*>/gi;
  const tags = html.match(imgTagRe) || [];

  const EXCLUDE_HINTS = /(logo|icon|favicon|sprite|avatar|pixel|tracking|badge|payment|visa|mastercard|paypal)/i;
  const INCLUDE_HINTS = /(product|produit|item|shop|boutique|gallery|catalog|catalogue)/i;

  for (const tag of tags) {
    const srcMatch =
      tag.match(/\bdata-src=["']([^"']+)["']/i) ||
      tag.match(/\bsrc=["']([^"']+)["']/i) ||
      tag.match(/\bsrcset=["']([^"']+)["']/i);
    if (!srcMatch) continue;

    let rawUrl = srcMatch[1].split(',')[0].trim().split(' ')[0]; // 1er candidat d'un srcset
    if (!rawUrl || rawUrl.startsWith('data:')) continue;

    // On exclut d'office tout ce qui a une signature logo/icône/tracker,
    // qu'elle soit dans l'URL ou dans les attributs class/alt/id de la balise.
    if (EXCLUDE_HINTS.test(rawUrl) || EXCLUDE_HINTS.test(tag)) continue;

    // On priorise (mais n'exige pas) un indice "produit" — certains sites
    // e-commerce simples n'ont pas de classes explicites, on ne veut pas
    // se priver de toutes leurs images pour autant.
    const hasProductHint = INCLUDE_HINTS.test(rawUrl) || INCLUDE_HINTS.test(tag);

    try {
      const absolute = new URL(rawUrl, baseUrl).toString();
      if (hasProductHint) {
        candidates.add(absolute); // ajouté en priorité (Set garde l'ordre d'insertion)
      }
    } catch {
      // URL invalide/relative mal formée : on ignore ce candidat.
    }
  }

  // 2e passe : si pas assez de candidats "avec indice produit", on complète
  // avec les <img> restantes (toujours filtrées des logos/icônes/trackers).
  if (candidates.size < MAX_PRODUCT_IMAGES_FROM_SITE) {
    for (const tag of tags) {
      const srcMatch = tag.match(/\bdata-src=["']([^"']+)["']/i) || tag.match(/\bsrc=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const rawUrl = srcMatch[1].trim();
      if (!rawUrl || rawUrl.startsWith('data:')) continue;
      if (EXCLUDE_HINTS.test(rawUrl) || EXCLUDE_HINTS.test(tag)) continue;
      try {
        const absolute = new URL(rawUrl, baseUrl).toString();
        candidates.add(absolute);
      } catch {
        // ignore
      }
      if (candidates.size >= MAX_PRODUCT_IMAGES_FROM_SITE * 2) break;
    }
  }

  return Array.from(candidates).slice(0, MAX_PRODUCT_IMAGES_FROM_SITE * 2);
}

/**
 * Récupère et vérifie jusqu'à `MAX_PRODUCT_IMAGES_FROM_SITE` vraies photos
 * produit depuis le site du client. Best-effort : retourne un tableau vide
 * (jamais une erreur bloquante) si le site est inaccessible ou n'a rien
 * d'exploitable.
 */
export async function extractRealProductImages(siteUrl: string): Promise<ReferenceImage[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(siteUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NexAI/1.0; +https://nexai.app) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const html = (await res.text()).slice(0, 300_000);
    const candidates = extractCandidateImageUrls(html, siteUrl);

    const verified: ReferenceImage[] = [];
    for (const url of candidates) {
      if (verified.length >= MAX_PRODUCT_IMAGES_FROM_SITE) break;
      if (await verifyImageUrl(url)) {
        verified.push({ url, kind: 'product', source: 'site_scrape' });
      }
    }
    return verified;
  } catch (err) {
    console.warn('[product-image-sourcing] Extraction images produit du site indisponible', err);
    return [];
  }
}

/**
 * Résout les mockups Pexels à utiliser pour les plans "ambiance/embellissement" :
 * - Site NexAI (siteId fourni) dont la proposition retenue a déjà des
 *   ambianceImages issues de Pexels (imageStyle === 'mockup') → on les
 *   réutilise telles quelles, aucun appel Pexels supplémentaire.
 * - Sinon (site externe, ou site NexAI généré en style 'realiste' donc sans
 *   mockup déjà en stock) → on source de nouvelles images via le service
 *   Pexels existant (sourceMockupImage), déjà utilisé pour les aperçus de
 *   site vitrine.
 * Best-effort : ne bloque jamais la génération vidéo si indisponible.
 */
export async function resolveMockupImages(params: {
  site: ISite | null;
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
}): Promise<ReferenceImage[]> {
  const { site, niche, brandName, description, tone } = params;

  // 1. Réutilisation d'un site NexAI déjà généré en style mockup — pas de
  // redondance, on ne repaie/ne re-sollicite jamais Pexels dans ce cas.
  if (site) {
    const chosenProposal =
      site.proposals?.find((p) => p.versionId === site.chosenProposalId) || site.proposals?.[0];
    if (chosenProposal?.imageStyle === 'mockup' && chosenProposal.ambianceImages?.length) {
      return chosenProposal.ambianceImages
        .slice(0, MAX_MOCKUP_IMAGES)
        .map((url) => ({ url, kind: 'mockup' as const, source: 'nexai_reuse' as const }));
    }
  }

  // 2. Site externe, ou site NexAI sans mockup déjà en stock → on source de
  // nouvelles images Pexels (mêmes garde-fous que site-image-sourcing :
  // sélection visuelle Claude + vérification de chargement).
  const fresh: ReferenceImage[] = [];
  const sectionHints = ['produit en situation', 'ambiance de marque', 'style de vie associé'];
  for (const sectionHint of sectionHints) {
    if (fresh.length >= MAX_MOCKUP_IMAGES) break;
    try {
      const result = await sourceMockupImage({
        niche,
        brandName,
        description,
        tone,
        sectionHint,
        orientation: 'landscape',
      });
      fresh.push({ url: result.url, kind: 'mockup', source: 'pexels_fresh' });
    } catch (err) {
      // Une niche/section sans résultat Pexels ne doit pas bloquer les autres.
      console.warn(`[product-image-sourcing] Mockup Pexels indisponible pour "${sectionHint}"`, err);
    }
  }
  return fresh;
}

/**
 * Point d'entrée principal : construit le pool complet (produits réels +
 * mockups) pour une vidéo donnée. Ne lève jamais d'exception — chaque étape
 * interne est déjà best-effort, ce point d'entrée additionne simplement les
 * résultats disponibles.
 */
export async function buildReferenceImagePool(params: {
  siteId?: string;
  liveSiteUrl: string | null;
  clientUploadedImageUrls?: string[];
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
}): Promise<ReferenceImagePool> {
  const { siteId, liveSiteUrl, clientUploadedImageUrls, niche, brandName, description, tone } = params;

  const site = siteId ? await Site.findById(siteId) : null;

  const [scraped, mockups] = await Promise.all([
    liveSiteUrl ? extractRealProductImages(liveSiteUrl) : Promise.resolve([]),
    resolveMockupImages({ site, niche, brandName, description, tone }),
  ]);

  // Uploads client : vérifiés (jamais fait confiance à une URL non chargeable),
  // et placés en tête de liste — ce sont les images que le client a choisi
  // lui-même de mettre en avant, priorité sur celles détectées automatiquement.
  const uploaded: ReferenceImage[] = [];
  for (const url of clientUploadedImageUrls || []) {
    if (typeof url !== 'string' || !url.trim()) continue;
    if (await verifyImageUrl(url)) {
      uploaded.push({ url, kind: 'product', source: 'client_upload' });
    }
  }

  return {
    productImages: [...uploaded, ...scraped],
    mockupImages: mockups,
  };
}
