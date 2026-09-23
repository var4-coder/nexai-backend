import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { AppError } from '@/middleware/errorHandler';

/**
 * Capture réelle d'un site (Playwright) : navigateur headless qui charge la
 * vraie URL, ferme les banners cookies courants (best-effort), puis scrolle
 * progressivement de haut en bas pendant l'enregistrement vidéo natif du
 * contexte Playwright.
 *
 * Utilisé pour le plan "capture réelle" du mixte : preuve concrète que le
 * site existe (vrai logo, vraies couleurs, vraie mise en page), à côté des
 * plans générés par IA (Grok Imagine + Alexya).
 *
 * Nécessite le binaire Chromium Playwright (package.json → "postinstall").
 * Son installation ne bloque JAMAIS le déploiement : si elle échoue (droits
 * insuffisants sur l'hébergeur), cette fonction lève une erreur explicite et
 * le pipeline vidéo poursuit avec un plan généré par IA.
 *
 * Best-effort par design, comme le reste du pipeline vidéo : si la capture
 * échoue (site inaccessible, timeout, popup bloquante...), l'appelant
 * (video-pipeline.service.ts) doit retomber sur un plan généré par IA
 * plutôt que de faire échouer toute la vidéo.
 */

const CAPTURE_DURATION_SECONDS = 8;
const SCROLL_STEPS = 20;

// Sélecteurs de banners cookies/consentement les plus courants (FR + EN).
// On s'arrête au premier qui matche et qui est réellement cliquable.
const COOKIE_DISMISS_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Tout accepter")',
  'button:has-text("J\'accepte")',
  'button:has-text("Accepter")',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  '[id*="cookie" i] button',
  '[class*="cookie" i] button',
  '[id*="consent" i] button',
];

export interface SiteCaptureResult {
  /** Chemin local du clip mp4 (silencieux), prêt à être concaténé avec les autres plans. */
  videoPath: string;
}

export async function captureSiteScreencast(params: {
  url: string;
  width: number;
  height: number;
  jobId: string;
}): Promise<SiteCaptureResult> {
  const { url, width, height, jobId } = params;
  const videoDir = path.join(os.tmpdir(), `capture_${jobId}_${Date.now()}`);
  await fs.mkdir(videoDir, { recursive: true });

  // Chromium peut être absent : sur certains hébergeurs (Render), son
  // installation échoue faute de droits root. On le signale clairement
  // plutôt que de laisser remonter une erreur technique obscure —
  // l'appelant retombe alors sur un plan généré par IA.
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new AppError(
      "Capture de site indisponible : le navigateur Chromium n'est pas installé sur ce serveur. La vidéo sera générée sans plan de capture réelle.",
      503,
      { cause: err instanceof Error ? err.message : String(err) }
    );
  }

  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: videoDir, size: { width, height } },
    });
    const page = await context.newPage();
    const video = page.video();

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (err) {
      throw new AppError(
        `Impossible de charger le site pour la capture réelle : ${(err as Error).message}`,
        502
      );
    }

    // Laisse le temps aux images/polices de charger — jamais bloquant, on
    // continue même si le site reste "occupé" en tâche de fond (analytics...).
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    // Ferme le premier banner cookies/consentement détecté — best-effort.
    for (const selector of COOKIE_DISMISS_SELECTORS) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 800 })) {
          await el.click({ timeout: 800 });
          await page.waitForTimeout(300);
          break;
        }
      } catch {
        // Sélecteur absent ou non cliquable sur ce site : on essaie le suivant.
      }
    }

    // Scroll progressif sur toute la hauteur de page, réparti sur la durée
    // cible — c'est ce déplacement qui est enregistré dans la vidéo.
    // Évaluations passées en string (pas en callback typé) pour ne pas
    // dépendre du lib "dom" dans le tsconfig backend (projet Node pur).
    const scrollHeight = await page
      .evaluate<number>('document.body.scrollHeight')
      .catch(() => height * 3);
    const maxScroll = Math.max(0, scrollHeight - height);

    for (let i = 0; i <= SCROLL_STEPS; i++) {
      const y = Math.round((maxScroll * i) / SCROLL_STEPS);
      await page.evaluate(`window.scrollTo(0, ${y})`).catch(() => {});
      await page.waitForTimeout((CAPTURE_DURATION_SECONDS * 1000) / SCROLL_STEPS);
    }

    await context.close(); // finalise l'écriture du fichier vidéo (.webm)

    const webmPath = video ? await video.path() : null;
    if (!webmPath) {
      throw new AppError('Playwright : aucune vidéo produite pour cette capture', 500);
    }

    // Le reste du pipeline (concat ffmpeg) attend du mp4/h264, pas du webm.
    const mp4Path = path.join(os.tmpdir(), `${jobId}_capture.mp4`);
    await convertWebmToMp4(webmPath, mp4Path);

    await fs.unlink(webmPath).catch(() => {});
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {});

    return { videoPath: mp4Path };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function convertWebmToMp4(inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-an',
      outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg conversion capture (webm→mp4) échouée (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable: ${err.message}`, 500)));
  });
}

/**
 * Captures d'écran d'un HTML, pour le juge visuel.
 *
 * Deux largeurs, parce que le responsive est le critère le plus lourd de la
 * grille de jugement (18 points, bloquant) :
 *  - 390 px : un téléphone courant, là où la majorité des visiteurs verront
 *    le site ;
 *  - 1280 px : un écran d'ordinateur.
 *
 * Le HTML est rendu directement en mémoire (setContent), sans URL : au
 * moment du jugement, le site n'est pas encore en ligne.
 *
 * Ne lève jamais d'erreur : en cas d'échec, renvoie une liste vide et le
 * juge retombe sur l'analyse du code. Une capture manquée ne doit jamais
 * bloquer une génération.
 */
export async function captureHtmlScreenshots(
  html: string
): Promise<{ base64: string; mediaType: 'image/png' | 'image/jpeg'; largeur: number }[]> {
  const largeurs = [390, 1280];
  let navigateur: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    navigateur = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const captures: { base64: string; mediaType: 'image/jpeg'; largeur: number }[] = [];
    for (const largeur of largeurs) {
      const page = await navigateur.newPage({
        viewport: { width: largeur, height: largeur < 600 ? 844 : 800 },
        deviceScaleFactor: 1,
      });
      // Les ressources externes (polices, images) peuvent ne pas se charger :
      // on n'attend pas indéfiniment, la structure suffit à juger.
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      // JPEG compressé : une page entière en PNG dépasserait vite la taille
      // raisonnable pour l'API, et la qualité reste largement suffisante
      // pour juger une mise en page.
      //
      // Hauteur bornée : l'API d'images réduit toute image trop grande, et
      // une page entière très haute deviendrait illisible une fois réduite.
      // Les 2 400 premiers pixels couvrent l'en-tête, la navigation et les
      // premières sections — l'essentiel de ce qui fait la qualité perçue.
      const hauteurPage = Number(await page.evaluate('document.body.scrollHeight')) || 800;
      const hauteur = Math.min(Math.max(hauteurPage, 400), 2400);
      const tampon = await page.screenshot({
        type: 'jpeg',
        quality: 60,
        fullPage: true,
        clip: { x: 0, y: 0, width: largeur, height: hauteur },
      });
      captures.push({ base64: tampon.toString('base64'), mediaType: 'image/jpeg', largeur });
      await page.close();
    }
    return captures;
  } catch (err) {
    console.warn('[site-capture] Captures du juge visuel indisponibles', err);
    return [];
  } finally {
    if (navigateur) await navigateur.close().catch(() => undefined);
  }
}
