import { chromium } from 'playwright';

/**
 * FILTRE DE QUALITÉ DES PHOTOS DE LA GALERIE (MEDIA.md, Librairie v8).
 *
 * Appliqué par le backend AVANT le codeur, à chaque photo candidate (stock de
 * la galerie NexAI et collecte automatique). Une photo qui échoue à un point
 * passe à la suivante.
 *   · Taille   : ≥ 1 600 px de large (≥ 2 400 px pour une photo plein écran) ;
 *   · Cadrage  : recadrage nécessaire ≤ 25 % pour le ratio de l'emplacement ;
 *   · Sujet    : clichés de banque d'images absents de la description ;
 *   · Netteté  : variance du Laplacien (mesurée ; filtre actif seulement
 *                quand PHOTO_NETTETE_MIN est réglé, après étalonnage).
 */

export const LARGEUR_MIN_SECTION = 1600;
export const LARGEUR_MIN_PLEIN_ECRAN = 2400;
export const RECADRAGE_MAX = 0.25;

/** « 16:9 » → 1.777… ; null si illisible. */
export function ratioNumerique(ratio?: string): number | null {
  if (!ratio) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[:/x]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(ratio);
  if (!m) return null;
  const a = parseFloat(m[1].replace(',', '.'));
  const b = parseFloat(m[2].replace(',', '.'));
  return a > 0 && b > 0 ? a / b : null;
}

/** Part de l'image perdue pour l'amener au ratio cible (0 = aucun recadrage). */
export function partRecadree(largeur: number, hauteur: number, ratioCible: number): number {
  if (!largeur || !hauteur || !ratioCible) return 0;
  const r = largeur / hauteur;
  return r > ratioCible ? 1 - ratioCible / r : 1 - r / ratioCible;
}

export function cadrageAcceptable(largeur: number | undefined, hauteur: number | undefined, ratio?: string): boolean {
  const cible = ratioNumerique(ratio);
  if (!cible || !largeur || !hauteur) return true;
  return partRecadree(largeur, hauteur, cible) <= RECADRAGE_MAX;
}

/**
 * Clichés de banque d'images (MEDIA.md « Sujet » + SLOP S14), cherchés dans la
 * description Pexels (en anglais). Les exclusions `photo.dont` des fiches
 * métier sont rédigées en français : elles ne sont pas comparables à cette
 * description et restent contrôlées par la requête et le juge visuel.
 */
const CLICHES = [
  'handshake',
  'shaking hands',
  'shake hands',
  'thumbs up',
  'thumb up',
  'white background',
  'isolated on white',
  'isolated background',
  'light bulb',
  'lightbulb',
  'hands on keyboard',
  'typing on keyboard',
  'typing on a keyboard',
  'hands typing',
  'open space office',
  'team laughing',
  'business people laughing',
  'caduceus',
  '3d render',
  '3d illustration',
  'clipart',
];

export function descriptionSansCliche(alt?: string): boolean {
  const a = (alt ?? '').toLowerCase();
  if (!a) return true;
  return !CLICHES.some((c) => a.includes(c));
}

/** Luminance relative approximative d'une couleur « #RRGGBB » (0 sombre → 1 clair). */
export function luminanceHex(hex?: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Netteté de plusieurs images (variance du Laplacien sur une version réduite
 * à 512 px de large), mesurée dans un navigateur headless. Renvoie une table
 * url → valeur ; une image non mesurable (CORS, délai…) est absente de la
 * table et n'est donc jamais refusée pour cette raison.
 */
export async function mesurerNettete(urls: string[]): Promise<Map<string, number>> {
  const sortie = new Map<string, number>();
  if (urls.length === 0) return sortie;
  let navigateur: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    navigateur = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await navigateur.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    for (const url of urls) {
      try {
        const valeur = (await page.evaluate(
          `(async (u) => {
            const img = new Image(); img.crossOrigin = 'anonymous';
            await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = u; setTimeout(ko, 15000); });
            const w = 512, h = Math.max(1, Math.round(img.naturalHeight * 512 / img.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h).data;
            const g = new Float32Array(w * h);
            for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2];
            let n = 0, s = 0, s2 = 0;
            for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
              const i = yy * w + xx;
              const l = g[i-w] + g[i+w] + g[i-1] + g[i+1] - 4 * g[i];
              n++; s += l; s2 += l * l;
            }
            const m = s / n; return s2 / n - m * m;
          })(${JSON.stringify(url)})`
        )) as number;
        if (Number.isFinite(valeur)) sortie.set(url, Math.round(valeur * 10) / 10);
      } catch {
        // Image non mesurable : jamais refusée pour cette seule raison.
      }
    }
  } catch (err) {
    console.warn('[photo-qualite] Mesure de netteté indisponible', (err as Error).message);
  } finally {
    if (navigateur) await navigateur.close().catch(() => undefined);
  }
  return sortie;
}
