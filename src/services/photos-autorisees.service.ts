import type { IPhotoAutorisee, SiteNiche } from '@/models/Site';
import { verifyImageUrl } from '@/utils/verifyMedia';
import { copierImagePourSite, versionOptimisee } from '@/services/cloudinary.service';
import { generateGrokImagine } from '@/services/grok-imagine.service';
import { callClaudeVision, type ClaudeModel } from '@/services/ai-clients';
import { getModelForRole } from '@/services/ai-role-registry';
import { prendreDuStockPourEmplacement, estNicheDeSite } from '@/services/site-photo-stock.service';
import { chercherPhotoPourEmplacement } from '@/services/site-image-sourcing.service';
import {
  LARGEUR_MIN_PLEIN_ECRAN,
  LARGEUR_MIN_SECTION,
  cadrageAcceptable,
  mesurerNettete,
} from '@/services/photo-qualite.service';
import { PhotoStock } from '@/models/PhotoStock';
import { env } from '@/config/env';
import {
  allowlistDe,
  familleDe,
  idNicheLibrairie,
  type CombinaisonSite,
  type LibrairieComplete,
} from '@/services/library.service';

/**
 * LISTE « PHOTOS AUTORISÉES » (MEDIA.md, Librairie v8) — remplie AVANT le
 * codeur, qui n'utilise QUE ces adresses (VETO sinon).
 *
 * Choix du client dans la conversation (décision du 02/10/2026) :
 *   · « client »  : ses propres images (produits / services) ;
 *   · « galerie » : images de la galerie NexAI ;
 *   · « mixte »   : les deux.
 * Le client qui a choisi ses images mais n'en a envoyé aucune reçoit la
 * galerie NexAI (il en a été prévenu dans la conversation).
 *
 * Ordre de remplissage (MEDIA.md) : (a) photos du client ; (b) galerie NexAI
 * de la niche (stock filtré, attribution unique) ; (c) collecte automatique
 * filtrée. Image avec le logo (décision du 03/10/2026) : seulement si le
 * client l'a demandée dans la conversation (brief.imageLogo) et qu'il a un
 * logo ; elle REMPLACE une photo de la galerie (le nombre d'images ne change
 * pas) et n'est gardée que si elle passe le même contrôle de qualité que la
 * galerie — sinon la photo de la galerie reste. Un emplacement que rien ne
 * remplit est simplement absent : le codeur utilise la variante de section
 * sans photo (jamais un bloc vide visible).
 */

export type ChoixPhotos = 'client' | 'galerie' | 'mixte';

const MAX_PHOTOS_CLIENT = 8;

export function choixPhotosDuBrief(brief: Record<string, unknown>): ChoixPhotos {
  const v = String(brief.photosChoix ?? '').toLowerCase();
  return v === 'client' || v === 'mixte' ? v : 'galerie';
}

export function photosClientDuBrief(brief: Record<string, unknown>): string[] {
  const liste = Array.isArray(brief.photosClient) ? brief.photosClient : [];
  return liste.map(String).filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_PHOTOS_CLIENT);
}

/** Variante plus large d'une photo de la galerie (Cloudinary w_1920 → w_2400) pour un plein écran. */
function versionPleinEcran(url: string, largeur?: number): string {
  return largeur && largeur >= LARGEUR_MIN_PLEIN_ECRAN ? url.replace(/(\/upload\/[^/]*)w_1920/, '$1w_2400') : url;
}

export async function construirePhotosAutorisees(params: {
  lib: LibrairieComplete;
  niche: SiteNiche;
  brief: Record<string, unknown>;
  combinaison: CombinaisonSite | null;
  siteId: string;
  plan: string;
  logoUrl?: string;
}): Promise<IPhotoAutorisee[]> {
  const { lib, niche, brief, combinaison } = params;
  const idNiche = idNicheLibrairie(niche);
  const slots = allowlistDe(lib).photo_slots?.[idNiche]?.slots ?? [];
  const fiche = lib.docs.library_niches.find((n) => String(n._id) === idNiche);
  const stylePhoto = String((fiche?.photo as { style?: string } | undefined)?.style ?? '');
  const sombre = combinaison ? familleDe(lib, combinaison.famille)?.sombre === true : false;
  const heroPleinEcran = combinaison?.hero === 'fullbleed';

  let choix = choixPhotosDuBrief(brief);
  const photos: IPhotoAutorisee[] = [];

  // (a) Photos du client — vérifiées une à une (le client ne voit jamais d'image cassée).
  if (choix !== 'galerie') {
    const urls = photosClientDuBrief(brief);
    const valides: string[] = [];
    for (const u of urls) if (await verifyImageUrl(u).catch(() => false)) valides.push(u);
    valides.forEach((url, i) => {
      const slot = choix === 'client' ? slots[i] : undefined;
      // Déjà stockée sur le Cloudinary NexAI (pièce jointe du chat) : version optimisée.
      photos.push({ url: versionOptimisee(url), source: 'client', ...(slot ? { slot: slot.slot, ratio: slot.ratio, label: slot.label } : {}) });
    });
    if (choix === 'client' && valides.length === 0) choix = 'galerie';
  }
  if (choix === 'client') return photos;

  // (b) puis (c) : un emplacement après l'autre.
  const briefImage = {
    niche,
    brandName: String(brief.brandName ?? ''),
    description: String(brief.description ?? ''),
    tone: String(brief.tone ?? ''),
    cible: String(brief.cible ?? ''),
  };
  const photographes: number[] = [];
  for (const [i, slot] of slots.entries()) {
    const estHero = slot.slot === 'hero' || i === 0;
    const largeurMin = estHero && heroPleinEcran ? LARGEUR_MIN_PLEIN_ECRAN : LARGEUR_MIN_SECTION;
    try {
      const duStock = estNicheDeSite(niche)
        ? await prendreDuStockPourEmplacement(niche, {
            ratio: slot.ratio,
            largeurMin,
            siteId: params.siteId,
            photographeIds: photographes,
            sombre,
          })
        : null;
      const enDirect = duStock
        ? null
        : await chercherPhotoPourEmplacement({
          ...briefImage,
          emplacement: `${slot.label ?? slot.slot} (${slot.slot})`,
          ratio: slot.ratio,
          largeurMin,
          stylePhoto,
        }).catch((err) => {
          console.warn(`[photos] Collecte automatique « ${slot.slot} » impossible`, (err as Error).message);
          return null;
        });
      // Photo trouvée en direct : copiée sur le Cloudinary NexAI (jamais de
      // lien direct vers Pexels, qui peut retirer la photo un jour). Si la
      // copie échoue, l'emplacement reste sans photo plutôt qu'avec un lien fragile.
      let trouvee: { url: string; photographer: string; pexelsUrl: string; width?: number; height?: number } | null = duStock;
      if (!trouvee && enDirect) {
        try {
          const copie = await copierImagePourSite(enDirect.url, params.siteId, `${slot.slot}-${Date.now()}`);
          trouvee = { ...enDirect, url: copie.url };
        } catch (err) {
          console.warn(`[photos] Copie de la photo « ${slot.slot} » impossible`, (err as Error).message);
        }
      }
      if (!trouvee) continue;
      if (duStock?.photographerId) photographes.push(duStock.photographerId);
      photos.push({
        url: estHero && heroPleinEcran ? versionPleinEcran(trouvee.url, trouvee.width) : trouvee.url,
        source: 'galerie',
        slot: slot.slot,
        ratio: slot.ratio,
        label: slot.label,
        width: trouvee.width,
        height: trouvee.height,
        photographer: trouvee.photographer,
        pexelsUrl: trouvee.pexelsUrl,
      });
    } catch (err) {
      console.warn(`[photos] Emplacement « ${slot.slot} » non rempli`, (err as Error).message);
    }
  }

  if (brief.imageLogo === true && params.logoUrl) {
    await remplacerParImageAvecLogo({
      photos,
      logoUrl: params.logoUrl,
      siteId: params.siteId,
      briefImage,
      heroPleinEcran,
    }).catch((err) => console.warn('[photos] Image avec logo non retenue — galerie conservée', (err as Error).message));
  }
  return photos;
}

/**
 * Scène publicitaire selon le métier : des personnes, véhicules, bâtiments ou
 * produits qui PORTENT la marque du client — jamais une image du logo seul.
 */
const SCENES_PAR_NICHE: Record<string, string> = {
  restaurant_gastronomie: 'a chef or a server wearing an apron printed with the brand logo, presenting a signature dish in a warm restaurant; or a branded delivery bag handed to a smiling customer',
  hotellerie_evenementiel: 'a welcoming hotel reception or event venue with the brand logo on the wall sign, staff in uniform with the logo, elegant guests',
  sante_bienetre: 'a caring practitioner in a white coat embroidered with the brand logo welcoming a patient in a bright, calm clinic or spa',
  immobilier_architecture: 'a modern residential building or villa with a professional sign bearing the brand logo, a real-estate agent holding a folder with the logo',
  services_locaux: 'a technician in a work uniform with the brand logo, next to a service van wrapped with the logo, at work in a client home',
  business_vitrine: 'a professional team in a modern office meeting room with the brand logo displayed on the glass wall',
  ecommerce_mode: 'a fashion model wearing the collection and holding a shopping bag printed with the brand logo, editorial lighting',
  portfolio_creatif: 'a creative studio with the brand logo on the wall, a designer or photographer at work, artistic atmosphere',
  tech_startup_saas: 'a person using a smartphone or laptop showing a clean app interface with the brand logo, in a bright modern workspace',
  education_formation: 'a trainer teaching an engaged group of learners in a modern classroom with a banner bearing the brand logo',
};

/** Consigne de l'image publicitaire (anglais : meilleure fidélité des modèles d'image). */
export function promptImagePublicitaire(
  brief: { niche: string; brandName: string; description: string; tone: string; cible?: string },
  format: string
): string {
  const scene = SCENES_PAR_NICHE[brief.niche] ?? 'people or products of this business in a real-life setting, carrying the brand logo';
  return (
    `Professional advertising photograph for the brand "${brief.brandName || 'the client'}". ` +
    (brief.description ? `Business: ${brief.description.slice(0, 300)}. ` : '') +
    `Scene: ${scene}. ` +
    `The provided logo must appear naturally IN the scene (sign, uniform, vehicle, packaging or product), clearly readable, ` +
    `faithful to the original: same shapes, same colors, not distorted, not redrawn, no misspelling. ` +
    `People, if any, look like the business's real customers${brief.cible ? ` (${brief.cible.slice(0, 120)})` : ''}, ` +
    `natural faces and hands, diverse when relevant. ` +
    `Photorealistic, high-end commercial photography, natural light, sharp focus, ${format} composition, ` +
    `space left for a headline on one side. No other text, no watermark, no collage, not an illustration.` +
    (brief.tone ? ` Mood: ${brief.tone.slice(0, 80)}.` : '')
  );
}

/** Validation visuelle de l'image avec logo (rôle « verif_image_logo », réglable dans l'admin). */
async function imageLogoValidee(
  imageUrl: string,
  logoUrl: string,
  brief: { niche: string; brandName: string }
): Promise<boolean> {
  try {
    const modele = (await getModelForRole('verif_image_logo')) as ClaudeModel;
    const brut = await callClaudeVision(
      modele,
      'Tu contrôles une image publicitaire avant sa mise sur le site d’un client. Tu réponds uniquement en JSON : {"valide": true|false, "raisons": ["…"]}.',
      `Image 1 = image publicitaire générée. Image 2 = logo officiel de la marque « ${brief.brandName} » (métier : ${brief.niche}).\n` +
        'Réponds "valide": true SEULEMENT si TOUT est vrai :\n' +
        '1. Le logo (ou le nom de la marque) est visible et lisible dans la scène, fidèle à l’image 2 : mêmes formes, mêmes couleurs, aucune lettre déformée ou mal écrite.\n' +
        '2. C’est une vraie photo réaliste et professionnelle (pas un dessin, pas un collage), nette.\n' +
        '3. Aucun visage, main ou corps déformé ; aucun texte parasite ou incohérent.\n' +
        '4. La scène correspond bien à ce métier.\n' +
        'Au moindre doute : "valide": false.',
      [imageUrl, logoUrl],
      { maxTokens: 300 }
    );
    const m = brut.match(/\{[\s\S]*\}/);
    const v = m ? (JSON.parse(m[0]) as { valide?: boolean; raisons?: string[] }) : null;
    if (v?.valide !== true) console.warn('[photos] Validation image avec logo :', (v?.raisons ?? []).join(' ; ').slice(0, 200));
    return v?.valide === true;
  } catch (err) {
    console.warn('[photos] Validation image avec logo indisponible — galerie conservée', (err as Error).message);
    return false;
  }
}

/** Formats acceptés par Grok Imagine (doc xAI, 10/2026). */
const FORMATS_GROK = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

/**
 * Remplace UNE photo de la galerie par une image réaliste de l'activité qui
 * intègre le logo du client (Grok Imagine, modèle le plus avancé, 2K).
 * Emplacement visé : le haut de page s'il n'est pas en plein écran, sinon le
 * premier emplacement de la galerie dont le format est disponible. L'image
 * n'est gardée que si elle atteint l'exigence de qualité de la galerie :
 * largeur minimale de l'emplacement, recadrage ≤ 25 %, netteté (si le seuil
 * est réglé). Sinon la photo de la galerie reste en place.
 */
async function remplacerParImageAvecLogo(params: {
  photos: IPhotoAutorisee[];
  logoUrl: string;
  siteId: string;
  briefImage: { niche: string; brandName: string; description: string; tone: string; cible?: string };
  heroPleinEcran: boolean;
}): Promise<void> {
  const { photos } = params;
  // Logo en PNG (un logo SVG n'est lu ni par le générateur d'images ni par la validation visuelle).
  if (/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(params.logoUrl)) {
    params = { ...params, logoUrl: params.logoUrl.replace('/image/upload/', '/image/upload/f_png,w_1024,c_limit/') };
  }
  const indice = photos.findIndex((p, i) => {
    if (p.source !== 'galerie') return false;
    const format = p.ratio ?? '16:9';
    if (!FORMATS_GROK.has(format)) return false;
    const estHero = p.slot === 'hero' || i === 0;
    // 2K = 2 048 px de large au plus : jamais sur un plein écran (2 400 px exigés).
    return !(estHero && params.heroPleinEcran);
  });
  if (indice < 0) return;
  const cible = photos[indice];
  const format = cible.ratio ?? '16:9';
  const estHero = cible.slot === 'hero' || indice === 0;
  const largeurMin = estHero && params.heroPleinEcran ? LARGEUR_MIN_PLEIN_ECRAN : LARGEUR_MIN_SECTION;

  const img = await generateGrokImagine({
    prompt: promptImagePublicitaire(params.briefImage, format),
    aspectRatio: format,
    imageUrl: params.logoUrl,
    tier: 'v2',
    resolution: '2k',
  });
  if (!(await verifyImageUrl(img.url))) return;
  // Copie obligatoire : l'adresse du générateur est temporaire.
  const copie = await copierImagePourSite(img.url, params.siteId, `image-logo-${Date.now()}`);
  const w = copie.width ?? 0;
  const h = copie.height ?? 0;
  if (w < largeurMin || !cadrageAcceptable(w, h, format)) {
    console.warn(`[photos] Image avec logo refusée : ${w}×${h} pour un emplacement ${format} (minimum ${largeurMin} px).`);
    return;
  }
  if (env.PHOTO_NETTETE_MIN > 0) {
    const net = (await mesurerNettete([copie.url])).get(copie.url);
    if (net !== undefined && net < env.PHOTO_NETTETE_MIN) {
      console.warn(`[photos] Image avec logo refusée : netteté ${net} < ${env.PHOTO_NETTETE_MIN}.`);
      return;
    }
  }
  // Validation visuelle (décision du 03/10/2026) : logo lisible et fidèle,
  // rendu photo réaliste, aucun texte parasite, personnes sans déformation.
  // Refus, doute ou validation indisponible → la photo de la galerie reste.
  if (!(await imageLogoValidee(copie.url, params.logoUrl, params.briefImage))) {
    console.warn('[photos] Image avec logo refusée à la validation visuelle — galerie conservée.');
    return;
  }
  // La photo de la galerie remplacée retourne dans le stock (jamais gaspillée).
  await PhotoStock.updateOne(
    { url: cible.url, siteId: params.siteId },
    { $set: { statut: 'disponible' }, $unset: { siteId: 1, attribueeLe: 1 } }
  ).catch(() => undefined);
  photos[indice] = {
    url: copie.url,
    source: 'generee',
    slot: cible.slot,
    ratio: cible.ratio,
    label: cible.label,
    width: w,
    height: h,
  };
}

/** Texte « PHOTOS AUTORISÉES » envoyé au codeur (et aux pages intérieures). */
export function textePhotosAutorisees(photos: IPhotoAutorisee[] | undefined): string {
  if (!photos || photos.length === 0) {
    return (
      'PHOTOS AUTORISÉES : aucune. N’utilise AUCUNE image photo (aucune URL) : pour chaque section prévue avec ' +
      'une photo, utilise sa variante SANS photo (texte seul ou aplat de la famille). Jamais de bloc vide, jamais de .ph-empty visible.'
    );
  }
  const origine = { client: 'photo du client', galerie: 'galerie NexAI', generee: 'image réaliste avec le logo' } as const;
  const lignes = photos.map((p, i) => {
    const emplacement = p.slot ? `emplacement « ${p.slot} »${p.label ? ` (${p.label})` : ''}${p.ratio ? `, ratio ${p.ratio}` : ''}` : 'emplacement libre';
    const taille = p.width && p.height ? `, ${p.width}×${p.height}` : '';
    return `${i + 1}. ${p.url} — ${origine[p.source]}, ${emplacement}${taille}`;
  });
  return (
    'PHOTOS AUTORISÉES (MEDIA.md) — les SEULES adresses d’images permises (VETO si une autre URL apparaît). ' +
    'Photos du client d’abord. Photo du haut de page : jamais en chargement différé (fetchpriority="high"), ' +
    'les autres en loading="lazy" ; width/height posés ; alt descriptif. Section prévue avec photo mais sans photo ' +
    'disponible : variante SANS photo, jamais de bloc vide.\n' +
    lignes.join('\n')
  );
}

/** Crédits Pexels des photos de la galerie (pied de page du site livré). */
export function creditsPhotos(photos: IPhotoAutorisee[] | undefined): Array<{ photographer: string; pexelsUrl: string }> {
  return (photos ?? [])
    .filter((p) => p.source === 'galerie' && p.photographer)
    .map((p) => ({ photographer: p.photographer!, pexelsUrl: p.pexelsUrl ?? 'https://www.pexels.com' }));
}
