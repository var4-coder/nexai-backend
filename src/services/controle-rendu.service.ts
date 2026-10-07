import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * PRÉ-JUGE PAR PROGRAMME (Librairie v8, labo-tests/checks2.js) — sans IA.
 *
 * Mesure sur le RENDU RÉEL, en quelques secondes, ce que les juges IA
 * devinent mal : débordement à 390 px (M3), prix coupés (M8), textes qui se
 * chevauchent ou passent sous un autre élément (M10), lettres de lignes de
 * titre qui se touchent (TY1), textes trop petits (TY4), cibles tactiles
 * (C2), contraste mesuré sur les pixels (C1), contenu caché sans JS (V11),
 * images cassées. Les défauts trouvés sont envoyés au réparateur avec leur
 * correction, comme ceux des juges.
 *
 * Il dit aussi si la page est NON LIVRABLE (décision du 02/10/2026) : défaut
 * GRAVE que le client ne peut pas réparer lui-même — page blanche, page
 * coupée, contenu invisible, texte illisible sur une grande partie.
 *
 * Ne lève jamais d'erreur : si le navigateur est indisponible, renvoie null
 * et la génération continue avec les juges IA seuls.
 */

const CHECKS_PATH = path.join(process.cwd(), 'seed-data', 'labo', 'checks2.js');
let checksJs: string | null = null;
function scriptChecks(): string {
  if (checksJs === null) checksJs = fs.readFileSync(CHECKS_PATH, 'utf-8');
  return checksJs;
}

export interface ErreurMesuree {
  regle: string;
  gravite: 'veto' | 'majeur' | 'mineur';
  ou: string;
  constat: string;
  correction_attendue: string;
  source: 'pre-juge';
  [k: string]: unknown;
}

export interface ResultatControle {
  erreurs: ErreurMesuree[];
  vetos: string[];
  /** Défauts graves non réparables par le client : la page n'est pas livrable. */
  graves: string[];
  /** Mesures brutes par largeur (diagnostic admin). */
  mesures: Record<string, unknown>;
}

interface MesureTexte {
  d: string;
  color: string;
  o: number;
  large: boolean;
  rects: [number, number, number, number][];
}

interface ResultatChecks {
  overflow: boolean;
  overlaps: string[];
  occluded: string[];
  ink: string[];
  priceWrap: string[];
  smallText: string[];
  tapSmall: string[];
  h1Lines: number;
  texts?: MesureTexte[];
}

const LARGEURS = [390, 768, 1280] as const;

async function preparerPage(navigateur: Browser, html: string, largeur: number, avecJs: boolean): Promise<{ page: Page; erreursJs: string[] }> {
  const contexte = await navigateur.newContext({
    viewport: { width: largeur, height: largeur < 500 ? 844 : 860 },
    deviceScaleFactor: 1,
    javaScriptEnabled: avecJs,
    reducedMotion: 'no-preference',
  });
  const page = await contexte.newPage();
  const erreursJs: string[] = [];
  page.on('pageerror', (e) => erreursJs.push(String(e.message || e).slice(0, 160)));
  await page.setContent(html, { waitUntil: 'load', timeout: 25000 }).catch(() => undefined);
  await page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined);
  if (avecJs) {
    // Défilement complet : les animations d'entrée se déclenchent toutes,
    // comme pour un vrai visiteur, avant la mesure.
    const h = Number(await page.evaluate('document.body ? document.body.scrollHeight : 0').catch(() => 0)) || 0;
    for (let y = 0; y < Math.min(h, 30000); y += 400) {
      await page.evaluate(`scrollTo(0, ${y})`).catch(() => undefined);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1300);
    await page.evaluate('scrollTo(0, 0)').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return { page, erreursJs };
}

/** Éléments de texte visibles mais transparents (contenu caché). */
const JS_MASQUES = `(() => {
  const els = [...document.querySelectorAll('h1,h2,h3,p,a,li,button,label')].filter(e => e.offsetParent && e.textContent.trim());
  const caches = els.filter(e => parseFloat(getComputedStyle(e).opacity) < 0.99);
  return { total: els.length, caches: caches.slice(0, 8).map(e => e.tagName + ' « ' + e.textContent.trim().slice(0, 30) + ' »'), nbCaches: caches.length };
})()`;

const JS_IMAGES_CASSEES = `[...document.images].filter(i => i.getAttribute('src') && (!i.complete || i.naturalWidth === 0)).map(i => i.getAttribute('src')).slice(0, 6)`;

const JS_VOLUME_TEXTE = `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return { car: t.length, hauteur: document.body ? document.body.scrollHeight : 0 }; })()`;

/** Neutralise éléments fixes / sticky et lien d'évitement (ils faussent les coordonnées), comme le labo v8. */
const JS_STATIQUE = `for (const e of document.querySelectorAll('body *')) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') e.style.setProperty('position', 'static', 'important'); }
for (const e of document.querySelectorAll('.skip-link,[class*=skip]')) { e.setAttribute('aria-hidden', 'true'); e.style.setProperty('display', 'none', 'important'); }`;

/**
 * Contraste mesuré sur les pixels : la page est photographiée texte rendu
 * transparent (on voit le fond réel : photo, voile, aplat), puis chaque texte
 * est comparé à ce fond (10ᵉ centile, comme le labo v8).
 */
async function contrastesMesures(navigateur: Browser, page: Page, textes: MesureTexte[]): Promise<{ echecs: { el: string; cr: number; besoin: number; car: number }[]; carTotal: number }> {
  if (textes.length === 0) return { echecs: [], carTotal: 0 };
  await page.evaluate('scrollTo(0, 0)').catch(() => undefined);
  await page.addStyleTag({
    content: '*,*::before,*::after,*::first-letter{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}',
  });
  const png = await page.screenshot({ fullPage: true, type: 'png' });
  const calcul = await navigateur.newPage();
  try {
    await calcul.setContent('<!doctype html><html><body></body></html>');
    return (await calcul.evaluate(
      `(async ({ src, textes }) => {
        const img = new Image();
        await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = src; });
        const W = img.naturalWidth, H = img.naturalHeight;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const echecs = []; let carTotal = 0;
        for (const t of textes) {
          const m = (t.color || '').match(/[\\d.]+/g); if (!m || m.length < 3) continue;
          const v = m.map(Number); const a = (v.length > 3 ? v[3] : 1) * t.o;
          const car = (t.d.match(/«(.*)»/) || ['', ''])[1].length;
          carTotal += Math.max(car, 1);
          let pire = 99;
          for (const [rx, ry, rw, rh] of t.rects) {
            const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry + rh * 0.15));
            const x1 = Math.min(W, Math.floor(rx + rw)), y1 = Math.min(H, Math.floor(ry + rh * 0.85));
            if (x1 - x0 < 2 || y1 - y0 < 2) continue;
            const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data;
            const n = d.length / 4, pas = Math.max(1, Math.floor(n / 400)), ratios = [];
            for (let i = 0; i < n; i += pas) {
              const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
              const fr = v[0] * a + r * (1 - a), fg = v[1] * a + g * (1 - a), fb = v[2] * a + b * (1 - a);
              const l1 = L(fr, fg, fb), l2 = L(r, g, b);
              ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
            }
            if (!ratios.length) continue;
            ratios.sort((p, q) => p - q);
            pire = Math.min(pire, ratios[Math.floor(ratios.length * 0.1)]);
          }
          const besoin = t.large ? 3 : 4.5;
          if (pire < besoin) echecs.push({ el: t.d, cr: Math.round(pire * 100) / 100, besoin, car: Math.max(car, 1) });
        }
        return { echecs, carTotal };
      })(${JSON.stringify({ src: `data:image/png;base64,${png.toString('base64')}`, textes })})`
    )) as { echecs: { el: string; cr: number; besoin: number; car: number }[]; carTotal: number };
  } finally {
    await calcul.close().catch(() => undefined);
  }
}

function liste(xs: string[], n = 3): string {
  return xs.slice(0, n).join(' ; ') + (xs.length > n ? ` (+${xs.length - n})` : '');
}

/**
 * Contrôle d'une page COMPLÈTE (kit inclus : c'est ce que verra le visiteur).
 */
export async function controlerRendu(html: string): Promise<ResultatControle | null> {
  if (!html) return null;
  let navigateur: Browser | null = null;
  const erreurs: ErreurMesuree[] = [];
  const graves: string[] = [];
  const mesures: Record<string, unknown> = {};
  try {
    navigateur = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const check = scriptChecks();

    // Page coupée : document non terminé.
    if (!/<\/html>\s*$/i.test(html.trim())) graves.push('page coupée (document HTML incomplet)');

    for (const largeur of LARGEURS) {
      const { page, erreursJs } = await preparerPage(navigateur, html, largeur, true);
      try {
        if (largeur === 390) {
          const volume = (await page.evaluate(JS_VOLUME_TEXTE)) as { car: number; hauteur: number };
          mesures.volume = volume;
          if (volume.car < 80 || volume.hauteur < 300) graves.push('page blanche (presque aucun contenu affiché)');
          const masques = (await page.evaluate(JS_MASQUES)) as { total: number; caches: string[]; nbCaches: number };
          mesures.masques = masques;
          if (masques.total > 0 && masques.nbCaches / masques.total > 0.4) {
            graves.push(`contenu invisible (${masques.nbCaches} textes sur ${masques.total} restent transparents)`);
          } else if (masques.nbCaches > 0) {
            erreurs.push({
              regle: 'V11', gravite: 'veto', ou: '390 px, avec JS', source: 'pre-juge',
              constat: `textes restés transparents après animation : ${liste(masques.caches)}`,
              correction_attendue: 'Ne jamais laisser un texte en opacity < 1 : supprimer l’état caché initial de ces éléments (seul kit/motion.js anime le haut de page, via data-geste).',
            });
          }
          const cassees = (await page.evaluate(JS_IMAGES_CASSEES)) as string[];
          if (cassees.length > 0) {
            erreurs.push({
              regle: 'MEDIA', gravite: 'veto', ou: 'images', source: 'pre-juge',
              constat: `image(s) qui ne se chargent pas : ${liste(cassees)}`,
              correction_attendue: 'Remplacer ces adresses par une URL de la liste PHOTOS AUTORISÉES, ou passer la section à sa variante SANS photo.',
            });
          }
          if (erreursJs.length > 0) mesures.erreursJs = erreursJs.slice(0, 5);
        }

        await page.evaluate(JS_STATIQUE).catch(() => undefined);
        // checks2.js est une fonction fléchée asynchrone : on l'appelle.
        const r = (await page.evaluate(`(${check.trim().replace(/;\s*$/, '')})()`)) as ResultatChecks;
        const textes = r.texts ?? [];
        delete r.texts;
        mesures[`w${largeur}`] = r;
        const ou = `${largeur} px`;
        if (r.overflow && largeur === 390) {
          erreurs.push({
            regle: 'M3', gravite: 'veto', ou, source: 'pre-juge',
            constat: 'la page déborde horizontalement (défilement de côté) à 390 px',
            correction_attendue: 'Supprimer toute largeur fixe en px sur les conteneurs ; img{max-width:100%} ; grilles en minmax(0,1fr) ; min-width:0 sur les enfants de grille/flex ; overflow-wrap:anywhere sur les longs mots et adresses.',
          });
        }
        if (r.priceWrap?.length) {
          erreurs.push({
            regle: 'M8', gravite: 'majeur', ou, source: 'pre-juge',
            constat: `prix coupés sur deux lignes : ${liste(r.priceWrap)}`,
            correction_attendue: 'Envelopper chaque prix dans <span class="prix"> avec white-space:nowrap.',
          });
        }
        const chevauchements = [...(r.overlaps ?? []), ...(r.occluded ?? [])];
        if (chevauchements.length) {
          erreurs.push({
            regle: 'M10', gravite: 'veto', ou, source: 'pre-juge',
            constat: `textes qui se chevauchent ou passent sous un autre élément : ${liste(chevauchements)}`,
            correction_attendue: 'Retirer le positionnement absolu / les marges négatives de ces éléments à cette largeur, ou leur réserver un espace (gap, padding) pour qu’aucun texte ne touche un autre élément.',
          });
        }
        if (r.ink?.length) {
          erreurs.push({
            regle: 'TY1', gravite: 'veto', ou, source: 'pre-juge',
            constat: `lettres de deux lignes de titre qui se touchent : ${liste(r.ink)}`,
            correction_attendue: 'Augmenter line-height de ces titres : ≥ 1.16 pour une police condensée en capitales, ≥ 1.12 pour des capitales accentuées, ≥ 1.02 sinon.',
          });
        }
        if (r.smallText?.length) {
          erreurs.push({
            regle: 'TY4', gravite: 'majeur', ou, source: 'pre-juge',
            constat: `textes trop petits : ${liste(r.smallText)}`,
            correction_attendue: 'Paragraphes ≥ 16 px ; textes secondaires courts 13–14 px ; jamais < 12 px.',
          });
        }
        if (largeur === 390 && r.tapSmall?.length) {
          erreurs.push({
            regle: 'C2', gravite: 'veto', ou, source: 'pre-juge',
            constat: `cibles tactiles trop petites : ${liste(r.tapSmall)}`,
            correction_attendue: 'min-height:44px (et min-width:44px pour une icône) sur ces liens et boutons, avec display:inline-flex;align-items:center.',
          });
        }
        if (largeur !== 768) {
          const { echecs, carTotal } = await contrastesMesures(navigateur, page, textes);
          const carEchec = echecs.reduce((s, e) => s + e.car, 0);
          mesures[`contraste${largeur}`] = { echecs: echecs.length, partCaracteres: carTotal ? carEchec / carTotal : 0 };
          if (largeur === 390 && carTotal > 0 && carEchec / carTotal > 0.4) {
            graves.push(`texte illisible sur une grande partie de la page (${Math.round((carEchec / carTotal) * 100)} % du texte sous le contraste minimal)`);
          }
          if (echecs.length) {
            erreurs.push({
              regle: 'C1', gravite: 'veto', ou, source: 'pre-juge',
              constat: `contraste mesuré insuffisant : ${liste(echecs.map((e) => `${e.el} ${e.cr}:1 (min ${e.besoin}:1)`))}`,
              correction_attendue: 'Texte sur fond uni : --ink (ou --muted pour un texte secondaire) ; accent en texte : --accent-text ; texte sur photo : voile ≥ 55 % sous le texte (CO3) ; aucune opacity sur un texte (CO5).',
            });
          }
        }
      } finally {
        await page.context().close().catch(() => undefined);
      }
    }

    // Sans JS : la page doit rester complète (AI_RULES, amélioration progressive).
    const sansJs = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const { page } = await preparerPage(navigateur, sansJs, 390, false);
    try {
      const masques = (await page.evaluate(JS_MASQUES)) as { total: number; caches: string[]; nbCaches: number };
      mesures.sansJs = masques;
      if (masques.nbCaches > 0) {
        erreurs.push({
          regle: 'V11', gravite: 'veto', ou: '390 px, SANS JS', source: 'pre-juge',
          constat: `textes cachés tant qu’un script n’a pas tourné : ${liste(masques.caches)}`,
          correction_attendue: 'L’état caché initial ne doit être posé que sous html.js (classe ajoutée par kit/motion.js) : la page doit être complète sans JS.',
        });
      }
    } finally {
      await page.context().close().catch(() => undefined);
    }
  } catch (err) {
    console.warn('[controle-rendu] Contrôle par programme indisponible', (err as Error).message);
    return null;
  } finally {
    if (navigateur) await navigateur.close().catch(() => undefined);
  }

  // Une même règle relevée à plusieurs largeurs : on garde les deux constats
  // (le réparateur doit corriger chaque largeur), dans la limite de 8.
  const ordre = { veto: 0, majeur: 1, mineur: 2 } as const;
  const triees = erreurs.sort((a, b) => ordre[a.gravite] - ordre[b.gravite]).slice(0, 8);
  return {
    erreurs: triees,
    vetos: Array.from(new Set(triees.filter((e) => e.gravite === 'veto').map((e) => e.regle))),
    graves: Array.from(new Set(graves)),
    mesures,
  };
}

/**
 * Adresses d'images présentes dans la page et absentes de la liste des
 * photos autorisées (VETO MEDIA.md). Contrôle de texte, sans navigateur.
 */
export function imagesHorsListe(html: string, autorisees: string[]): string[] {
  const permis = new Set(autorisees);
  const trouvees = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) trouvees.add(m[1]);
  for (const m of html.matchAll(/<source\b[^>]*\bsrcset\s*=\s*["']([^"'\s,]+)/gi)) trouvees.add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi)) trouvees.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*rel=["']preload["'][^>]*href=["'](https?:\/\/[^"']+)["']/gi)) trouvees.add(m[1]);
  return [...trouvees].filter(
    (u) => /^https?:\/\//i.test(u) && !permis.has(u) && !/fonts\.(googleapis|gstatic)\.com/i.test(u)
  );
}
