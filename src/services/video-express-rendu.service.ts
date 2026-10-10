import { chromium, type Browser } from 'playwright';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Pub Express — rendu de la vidéo animée.
 *
 * Le scénario (plans, textes, mouvements, transitions) est écrit en amont ;
 * ce module le transforme en MP4, SANS aucun fournisseur vidéo payant :
 *  1. une page HTML contient tous les plans (photos du client, captures du
 *     site, logo, textes) ;
 *  2. une fonction `__seek(t)` place chaque élément à l'instant t, de façon
 *     déterministe (aucune animation CSS libre : chaque image est exacte) ;
 *  3. Chromium photographie chaque image de la vidéo, ffmpeg les assemble.
 *
 * Coût : quelques secondes à quelques minutes de calcul serveur, 0 $ de
 * fournisseur. Les polices sont livrées avec le serveur (assets/polices).
 */

export type TypePlan = 'accroche' | 'produit' | 'site' | 'atouts' | 'appel';
export type Mouvement = 'zoom_avant' | 'zoom_arriere' | 'gauche' | 'droite';
export type Transition = 'fondu' | 'glisse' | 'zoom';

export interface PlanExpress {
  type: TypePlan;
  /** Durée du plan en secondes. */
  duree: number;
  /** Index de l'image (photos) utilisée en fond. */
  image?: number;
  titre?: string;
  sousTitre?: string;
  /** Plan « atouts » : 2 à 3 points courts. */
  points?: string[];
  mouvement?: Mouvement;
  transition?: Transition;
}

export interface StoryboardExpress {
  plans: PlanExpress[];
  /** Couleur d'accent, hexadécimale (#RRGGBB). */
  couleur: string;
  marque: string;
  /** Texte du bouton final (« Commander sur WhatsApp »…). */
  cta: string;
  /** Contact ou adresse affichée sous le bouton (facultatif). */
  contact?: string;
}

export interface ImageExpress {
  /** Image encodée (JPEG, PNG ou WEBP). */
  donnees: Buffer;
  type: string;
}

const DUREE_TRANSITION = 0.45;
/** Durée maximale d'un rendu (une 30 s prend 1 à 3 minutes). */
const DELAI_MAX_RENDU_MS = 12 * 60 * 1000;
/** Chromium : celui installé par Playwright (serveur), ou un autre chemin fourni (postes de test). */
const lancer = () =>
  chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  });
const DOSSIER_POLICES = path.resolve(__dirname, '../../assets/polices');

function echapper(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function couleurValide(c: string | undefined): string {
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : '#F59E0B';
}

async function policesCss(): Promise<string> {
  const graisses: [string, number][] = [
    ['Inter-Medium.otf', 500],
    ['Inter-Bold.otf', 700],
    ['Inter-ExtraBold.otf', 800],
    ['Inter-Black.otf', 900],
  ];
  const blocs: string[] = [];
  for (const [fichier, poids] of graisses) {
    try {
      const b64 = (await fs.readFile(path.join(DOSSIER_POLICES, fichier))).toString('base64');
      blocs.push(`@font-face{font-family:'NX';src:url(data:font/otf;base64,${b64}) format('opentype');font-weight:${poids};}`);
    } catch {
      /* police absente : repli sur les polices du système */
    }
  }
  return blocs.join('\n');
}

const dataUri = (im: ImageExpress) => `data:${im.type};base64,${im.donnees.toString('base64')}`;

/** Construit la page HTML de la vidéo (tous les plans + la fonction __seek). */
export async function construirePage(p: {
  storyboard: StoryboardExpress;
  images: ImageExpress[];
  captureSite?: ImageExpress;
  logo?: ImageExpress;
  largeur: number;
  hauteur: number;
}): Promise<{ html: string; duree: number }> {
  const { storyboard: sb, images, largeur: W, hauteur: H } = p;
  const vertical = H > W;
  const u = Math.min(W, H) / 100; // unité de mise en page
  const accent = couleurValide(sb.couleur);
  const imageDe = (i?: number) => (images.length ? images[Math.abs(i ?? 0) % images.length] : undefined);

  let t = 0;
  const meta: { debut: number; duree: number; mouvement: Mouvement; transition: Transition; type: TypePlan }[] = [];
  const scenes = sb.plans.map((pl, i) => {
    const duree = Math.max(0.5, pl.duree || 3); // la somme exacte est garantie par le scénario
    meta.push({
      debut: t,
      duree,
      mouvement: pl.mouvement ?? (['zoom_avant', 'gauche', 'zoom_arriere', 'droite'] as Mouvement[])[i % 4],
      transition: i === 0 ? 'fondu' : pl.transition ?? 'fondu',
      type: pl.type,
    });
    t += duree;
    const img = imageDe(pl.image);
    const titre = pl.titre ? `<div class="titre e" data-d="0.15">${echapper(pl.titre)}</div>` : '';
    const sous = pl.sousTitre ? `<div class="sous e" data-d="0.45">${echapper(pl.sousTitre)}</div>` : '';
    const fond = img ? `<img class="media" src="${dataUri(img)}" />` : '';

    if (pl.type === 'site' && p.captureSite) {
      return `<section class="scene site" id="s${i}">
        <div class="degrade"></div>
        <div class="haut">${titre}</div>
        <div class="appareil ${vertical ? 'tel' : 'nav'} e" data-d="0.05"><div class="ecran"><img class="defile" src="${dataUri(p.captureSite)}" /></div></div>
        <div class="bas">${sous}</div>
      </section>`;
    }
    if (pl.type === 'atouts') {
      const points = (pl.points ?? []).slice(0, 3)
        .map((pt, k) => `<div class="point e" data-d="${0.5 + k * 0.45}"><span class="coche">✓</span><span>${echapper(pt)}</span></div>`)
        .join('');
      return `<section class="scene atouts" id="s${i}">${fond}<div class="voile fort"></div>
        <div class="centre">${titre}<div class="points">${points}</div></div></section>`;
    }
    if (pl.type === 'appel') {
      const logo = p.logo ? `<img class="logo e" data-d="0.05" src="${dataUri(p.logo)}" />` : '';
      return `<section class="scene appel" id="s${i}"><div class="fondappel"></div>
        <div class="centre">${logo}<div class="marque e" data-d="0.3">${echapper(sb.marque)}</div>
        ${pl.titre ? `<div class="sous e" data-d="0.55">${echapper(pl.titre)}</div>` : ''}
        <div class="bouton e" data-d="0.8">${echapper(sb.cta)}</div>
        ${sb.contact ? `<div class="contact e" data-d="1.05">${echapper(sb.contact)}</div>` : ''}</div></section>`;
    }
    if (pl.type === 'accroche') {
      return `<section class="scene accroche" id="s${i}">${fond}<div class="voile"></div>
        <div class="centre">${titre}<div class="barre e" data-d="0.35"></div>${sous}</div></section>`;
    }
    // produit (et site sans capture)
    return `<section class="scene produit" id="s${i}">${fond}<div class="voile bas"></div>
      <div class="tiers">${pl.sousTitre ? `<div class="etiquette e" data-d="0.1">${echapper(pl.sousTitre)}</div>` : ''}${pl.titre ? `<div class="titre e" data-d="0.3">${echapper(pl.titre)}</div>` : ''}</div></section>`;
  });
  const duree = t;

  const css = `${await policesCss()}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:#0b0b0f;font-family:'NX','Inter','DejaVu Sans',Arial,sans-serif;color:#fff}
  .scene{position:absolute;inset:0;overflow:hidden;opacity:0;will-change:opacity,transform}
  .media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center}
  .voile{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,.15) 40%,rgba(0,0,0,.7) 100%)}
  .voile.fort{background:linear-gradient(180deg,rgba(0,0,0,.55),rgba(0,0,0,.75))}
  .voile.bas{background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.85) 100%)}
  .centre{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 ${7 * u}px;gap:${2.4 * u}px}
  .titre{font-weight:900;font-size:${vertical ? 8.6 * u : 7 * u}px;line-height:1.04;letter-spacing:-0.02em;text-shadow:0 ${0.4 * u}px ${2 * u}px rgba(0,0,0,.45);max-width:100%}
  .sous{font-weight:700;font-size:${vertical ? 4.4 * u : 3.6 * u}px;line-height:1.2;opacity:.95;text-shadow:0 ${0.3 * u}px ${1.2 * u}px rgba(0,0,0,.5)}
  .barre{width:${18 * u}px;height:${1.1 * u}px;border-radius:${u}px;background:${accent};transform-origin:center}
  .tiers{position:absolute;left:${6 * u}px;right:${6 * u}px;bottom:${vertical ? 16 * u : 9 * u}px;display:flex;flex-direction:column;align-items:flex-start;gap:${1.8 * u}px}
  .tiers .titre{text-align:left}
  .etiquette{background:${accent};color:#111;font-weight:800;font-size:${3.4 * u}px;padding:${0.9 * u}px ${2.4 * u}px;border-radius:${10 * u}px;text-transform:uppercase;letter-spacing:.04em}
  .degrade{position:absolute;inset:0;background:radial-gradient(circle at 30% 20%,${accent}55,transparent 60%),linear-gradient(160deg,#111827,#030712)}
  .site .haut{position:absolute;top:${vertical ? 9 * u : 5 * u}px;left:${6 * u}px;right:${6 * u}px;text-align:center}
  .site .haut .titre{font-size:${vertical ? 6.6 * u : 5 * u}px}
  .site .bas{position:absolute;bottom:${vertical ? 8 * u : 4 * u}px;left:${6 * u}px;right:${6 * u}px;text-align:center}
  .appareil{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#111;box-shadow:0 ${3 * u}px ${8 * u}px rgba(0,0,0,.6)}
  .appareil.tel{width:${62 * u}px;height:${118 * u}px;border-radius:${7 * u}px;padding:${1.6 * u}px;top:52%}
  .appareil.nav{width:${130 * u}px;height:${70 * u}px;border-radius:${1.6 * u}px;padding:${3.2 * u}px ${0.8 * u}px ${0.8 * u}px}
  .ecran{width:100%;height:100%;overflow:hidden;border-radius:${5.6 * u}px;background:#fff;position:relative}
  .nav .ecran{border-radius:${0.6 * u}px}
  .defile{width:100%;display:block;position:absolute;top:0;left:0}
  .points{display:flex;flex-direction:column;gap:${2.6 * u}px;align-items:flex-start;margin-top:${2 * u}px}
  .point{display:flex;align-items:center;gap:${2.4 * u}px;font-weight:800;font-size:${vertical ? 5 * u : 4 * u}px;text-align:left;line-height:1.15}
  .coche{flex:none;width:${7 * u}px;height:${7 * u}px;border-radius:50%;background:${accent};color:#111;display:flex;align-items:center;justify-content:center;font-size:${4 * u}px;font-weight:900}
  .fondappel{position:absolute;inset:0;background:radial-gradient(circle at 50% 35%,${accent}66,transparent 55%),linear-gradient(180deg,#0f172a,#020617)}
  .logo{max-width:${40 * u}px;max-height:${26 * u}px;object-fit:contain;background:#fff;border-radius:${3 * u}px;padding:${2 * u}px}
  .marque{font-weight:900;font-size:${vertical ? 8 * u : 6.4 * u}px;letter-spacing:-0.02em}
  .bouton{background:${accent};color:#111;font-weight:900;font-size:${vertical ? 5 * u : 4 * u}px;padding:${2.4 * u}px ${6 * u}px;border-radius:${12 * u}px;box-shadow:0 ${1.4 * u}px ${5 * u}px ${accent}88;margin-top:${1.5 * u}px}
  .contact{font-weight:700;font-size:${3.6 * u}px;opacity:.85}
  `;

  const script = `
  const META = ${JSON.stringify(meta)};
  const TR = ${DUREE_TRANSITION};
  const W = ${W}, U = ${u};
  const scenes = META.map((_, i) => document.getElementById('s' + i));
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const easeInOut = (x) => { x = clamp(x); return x < .5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2; };
  // Ajuste la taille des titres pour qu'ils tiennent (une fois, au chargement).
  function ajuster() {
    document.querySelectorAll('.titre,.marque,.sous,.point').forEach((el) => {
      let taille = parseFloat(getComputedStyle(el).fontSize);
      const maxH = el.classList.contains('titre') || el.classList.contains('marque') ? ${(H * 0.32).toFixed(0)} : ${(H * 0.14).toFixed(0)};
      let garde = 0;
      while ((el.scrollWidth > el.parentElement.clientWidth + 2 || el.scrollHeight > maxH) && taille > 12 && garde++ < 60) {
        taille *= 0.94; el.style.fontSize = taille + 'px';
      }
    });
    document.querySelectorAll('.defile').forEach((img) => { img.dataset.h = img.getBoundingClientRect().height; });
  }
  window.__seek = function (t) {
    META.forEach((m, i) => {
      const el = scenes[i];
      const fin = m.debut + m.duree + (i < META.length - 1 ? TR : 0);
      if (t < m.debut || t > fin) { el.style.opacity = 0; return; }
      const local = t - m.debut;
      const entree = i === 0 ? 1 : easeOut(local / TR);
      el.style.zIndex = i + 1;
      el.style.opacity = entree;
      let tr = '';
      if (m.transition === 'glisse' && i > 0) tr = 'translateX(' + ((1 - entree) * 100) + '%)';
      if (m.transition === 'zoom' && i > 0) tr = 'scale(' + (1.12 - 0.12 * entree) + ')';
      el.style.transform = tr;
      const p = clamp(local / (m.duree + TR));
      const media = el.querySelector('.media');
      if (media) {
        const mv = m.mouvement;
        let s = 1.08, x = 0;
        if (mv === 'zoom_avant') s = 1.04 + 0.14 * easeInOut(p);
        if (mv === 'zoom_arriere') s = 1.18 - 0.14 * easeInOut(p);
        if (mv === 'gauche') { s = 1.14; x = 4 - 8 * easeInOut(p); }
        if (mv === 'droite') { s = 1.14; x = -4 + 8 * easeInOut(p); }
        media.style.transform = 'scale(' + s + ') translateX(' + x + '%)';
      }
      el.querySelectorAll('.e').forEach((x) => {
        const d = parseFloat(x.dataset.d || '0');
        const k = easeOut((local - d) / 0.55);
        x.style.opacity = k;
        if (x.classList.contains('barre')) x.style.transform = 'scaleX(' + k + ')';
        else if (x.classList.contains('appareil')) x.style.transform = 'translate(-50%,' + (-50 + (1 - k) * 12) + '%)';
        else if (x.classList.contains('bouton')) {
          const pulse = local > d + 0.6 ? 1 + 0.035 * Math.sin((local - d) * 5) : 1;
          x.style.transform = 'translateY(' + ((1 - k) * 5 * U) + 'px) scale(' + pulse + ')';
        } else if (x.classList.contains('logo')) x.style.transform = 'scale(' + (0.8 + 0.2 * k) + ')';
        else x.style.transform = 'translateY(' + ((1 - k) * 5 * U) + 'px)';
      });
      const defile = el.querySelector('.defile');
      if (defile) {
        const ecran = defile.parentElement.getBoundingClientRect().height;
        const h = parseFloat(defile.dataset.h || '0');
        const course = Math.max(0, h - ecran);
        defile.style.transform = 'translateY(' + (-course * easeInOut((local - 0.6) / Math.max(1, m.duree - 1))) + 'px)';
      }
    });
  };
  window.__pret = document.fonts.ready.then(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {})))).then(ajuster);
  `;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${scenes.join('\n')}<script>${script}</script></body></html>`;
  return { html, duree };
}

/**
 * Rend la vidéo silencieuse (MP4 H.264) à partir du scénario.
 * Renvoie la durée réelle en secondes.
 */
export async function rendreVideoExpress(p: {
  storyboard: StoryboardExpress;
  images: ImageExpress[];
  captureSite?: ImageExpress;
  logo?: ImageExpress;
  largeur: number;
  hauteur: number;
  fps: number;
  sortie: string;
}): Promise<{ duree: number }> {
  const { html, duree } = await construirePage(p);
  // Page à côté de la vidéo : un nom unique par vidéo, sans collision entre deux rendus simultanés.
  const pagePath = `${p.sortie}.html`;
  await fs.writeFile(pagePath, html);

  let navigateur: Browser | null = null;
  let ffmpeg: ReturnType<typeof spawn> | null = null;
  // Garde-fou : un rendu ne peut jamais bloquer le worker indéfiniment.
  const limite = setTimeout(() => {
    ffmpeg?.kill('SIGKILL');
    navigateur?.close().catch(() => undefined);
  }, DELAI_MAX_RENDU_MS);
  try {
    navigateur = await lancer();
    const page = await navigateur.newPage({ viewport: { width: p.largeur, height: p.hauteur }, deviceScaleFactor: 1 });
    await page.goto(`file://${pagePath}`, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate('window.__pret');

    const nbImages = Math.round(duree * p.fps);
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(p.fps),
      '-c:v', 'mjpeg',
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-r', String(p.fps),
      '-movflags', '+faststart',
      p.sortie,
    ]);
    ffmpeg = proc;
    let erreurs = '';
    proc.stderr!.on('data', (d) => (erreurs = (erreurs + d.toString()).slice(-4000)));
    // Une écriture après la mort de ffmpeg (EPIPE) ne doit jamais faire tomber le worker.
    proc.stdin!.on('error', () => undefined);
    const termine = new Promise<void>((ok, ko) => {
      proc.on('error', ko);
      proc.on('close', (code) => (code === 0 ? ok() : ko(new Error(`Montage de la Pub Express interrompu (code ${code}) : ${erreurs.slice(-600)}`))));
    });
    termine.catch(() => undefined); // évite un rejet non géré si la boucle s'arrête avant

    for (let f = 0; f < nbImages; f++) {
      if (proc.exitCode !== null) break;
      await page.evaluate(`window.__seek(${(f / p.fps).toFixed(4)})`);
      const image = await page.screenshot({ type: 'jpeg', quality: 90 });
      if (!proc.stdin!.write(image)) {
        await Promise.race([new Promise((r) => proc.stdin!.once('drain', r)), termine.then(() => undefined, () => undefined)]);
      }
    }
    proc.stdin!.end();
    await termine;
    return { duree };
  } finally {
    clearTimeout(limite);
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    if (navigateur) await navigateur.close().catch(() => undefined);
  }
}

/**
 * Capture de la page d'accueil d'un site, en hauteur (pour le plan « site »
 * qui la fait défiler dans un téléphone ou un navigateur). Best-effort.
 */
export async function capturerSitePourExpress(url: string, vertical: boolean): Promise<ImageExpress | undefined> {
  let navigateur: Browser | null = null;
  try {
    navigateur = await lancer();
    const largeur = vertical ? 390 : 1280;
    const page = await navigateur.newPage({ viewport: { width: largeur, height: vertical ? 844 : 800 }, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const hauteur = Math.min(Number(await page.evaluate('document.body.scrollHeight')) || 2000, vertical ? 3600 : 2600);
    const donnees = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: true, clip: { x: 0, y: 0, width: largeur, height: hauteur } });
    return { donnees, type: 'image/jpeg' };
  } catch (err) {
    console.warn('[video-express] Capture du site indisponible', (err as Error)?.message);
    return undefined;
  } finally {
    if (navigateur) await navigateur.close().catch(() => undefined);
  }
}
