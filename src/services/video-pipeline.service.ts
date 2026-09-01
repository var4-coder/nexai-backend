import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { HydratedDocument } from 'mongoose';
import { VideoAd } from '@/models/VideoAd';
import { Site, ISite } from '@/models/Site';
import { User } from '@/models/User';
import { callClaude } from '@/services/ai-clients';
import { generateGrokImagine } from '@/services/grok-imagine.service';
import {
  generateAlexyaVideoClip,
  uploadVideoStartFrameFromUrl,
} from '@/services/alexya-video.service';
import {
  generateAvatarClip,
  FALAI_AVATAR_MAX_SECONDS_PER_CALL,
  type AvatarQuality,
} from '@/services/falai-avatar.service';
import { synthesizeSpeech, estimateSpeechDurationSeconds, pickVoiceId } from '@/services/tts.service';
import { uploadVideoAd, uploadNarrationAudio } from '@/services/cloudinary.service';
import {
  creditCredits,
  debitCredits,
  getVideoAdCreditCost,
  getVideoAdRelaunchCost,
  assertVideoAdModeAllowed,
  VideoAdFormat,
  VideoAdMode,
} from '@/services/credits.service';
import { AppError } from '@/middleware/errorHandler';
import { pipelineQueue } from '@/jobs/queue';
import { Job as JobModel } from '@/models/Job';
import { fetchSiteMeta } from '@/services/site-meta.service';
import { generateLogoProposals } from '@/services/recraft.service';
import { captureSiteScreencast } from '@/services/site-capture.service';
import { verifyImageUrl } from '@/utils/verifyMedia';
import { resolveMusicTrack } from '@/data/library/musicTracks';
import {
  buildReferenceImagePool,
  type ReferenceImage,
  type ReferenceImagePool,
} from '@/services/product-image-sourcing.service';
import { analyzeVideoBriefCompleteness } from '@/services/video-brief-quality.service';
import { assertBusinessCompliant } from '@/services/content-compliance.service';
import {
  evaluateFinalVideoIntegrity,
  checkVoiceOverMusicBalance,
  MIN_VOICE_OVER_MUSIC_DB,
} from '@/services/video-qc.service';
import { buildSiteContentDossier } from '@/services/site-content-analysis.service';
import { env } from '@/config/env';

/** Nombre d'offres distinctes détectées au-delà duquel on recommande (sans
 * bloquer) un format plus long qu'une 30s, trop courte pour toutes les citer. */
const MANY_OFFERS_THRESHOLD = 3;

/**
 * Lance une génération de vidéo pub : vérifie le plan, débite les crédits
 * immédiatement (remboursement automatique en cas d'échec — voir processVideoAd),
 * puis enqueue le job BullMQ.
 */
export async function enqueueVideoAd(
  userId: string,
  opts: {
    siteId?: string;
    mode: VideoAdMode;
    format: VideoAdFormat;
    aspectRatio: '16:9' | '9:16';
    brief: Record<string, unknown>;
  }
) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  assertVideoAdModeAllowed(user.plan, opts.mode);

  let site: HydratedDocument<ISite> | null = null;
  if (opts.siteId) {
    site = await Site.findById(opts.siteId);
    if (!site) throw new AppError('Site introuvable', 404);
    if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé', 403);
  }

  // Si une URL externe est fournie, on la valide immédiatement (fail-fast)
  const siteUrl = typeof opts.brief?.siteUrl === 'string' ? (opts.brief.siteUrl as string).trim() : '';
  if (siteUrl) {
    try {
      const meta = await fetchSiteMeta(siteUrl);
      // On enrichit le brief avec les métadonnées pour le worker
      opts.brief = {
        ...opts.brief,
        siteUrl: meta.url,
        siteMeta: {
          title: meta.title,
          description: meta.description,
          h1: meta.h1,
          ogImage: meta.ogImage,
          snippet: meta.rawSnippet,
        },
      };
    } catch (err) {
      throw new AppError(
        (err as Error).message || "L'URL du site fournie n'est pas accessible ou invalide.",
        400
      );
    }
  }

  // Dossier de contenu du site — construit systématiquement dès qu'un site
  // (NexAI via siteId, ou externe via siteUrl) est disponible, AVEC ou SANS
  // description libre du client. Corrige un bug de fond : avant, un client
  // choisissant un site NexAI existant sans taper de texte n'avait aucun
  // contexte réel injecté dans les prompts (seulement la catégorie/niche).
  // Best-effort total (voir buildSiteContentDossier) : ne bloque jamais et
  // ne fait jamais échouer la génération si le site est illisible.
  const dossier = await buildSiteContentDossier({ site, externalUrl: siteUrl || undefined });
  if (dossier.dossierText) {
    opts.brief = {
      ...opts.brief,
      siteContentDossier: dossier.dossierText,
      offerHighlights: dossier.offerHighlights,
    };
  }

  // Scan qualité du brief — UNIQUEMENT quand ni un site NexAI (siteId) ni une
  // URL externe (siteUrl) ne sont fournis : dans ces deux cas, le pipeline a
  // déjà de quoi personnaliser la vidéo (contenu du site réel), le scan est
  // inutile. Sans aucun des deux, le script publicitaire dépend entièrement
  // de ce texte libre : on bloque AVANT tout débit de crédits si c'est trop
  // vague, avec un retour actionnable pour orienter le client — garde-fou
  // serveur réel, pas seulement une vérification côté frontend.
  if (!opts.siteId && !siteUrl) {
    const briefText = opts.brief as { description?: string; brandName?: string; ctaText?: string };
    const analysis = await analyzeVideoBriefCompleteness({
      description: briefText.description,
      brandName: briefText.brandName,
      ctaText: briefText.ctaText,
    });
    if (!analysis.complete) {
      throw new AppError(analysis.feedback || 'Votre description est incomplète pour générer une vidéo pertinente.', 422, {
        missingElements: analysis.missingElements,
      });
    }
  }

  const cost = getVideoAdCreditCost(opts.mode, opts.format);

  // Garde-fou légal/fraude — voir content-compliance.service.ts. S'applique
  // même quand un site/URL est fourni (le texte libre du brief peut décrire
  // une activité problématique indépendamment du site associé).
  const briefForCompliance = opts.brief as { description?: string; brandName?: string };
  const compliance = await assertBusinessCompliant({
    description: briefForCompliance.description,
    brandName: briefForCompliance.brandName,
  });
  if (!compliance.allowed) {
    console.warn(`[video-pipeline] Génération bloquée (conformité) user=${userId} : ${compliance.reason}`);
    throw new AppError(compliance.clientMessage, 403, { complianceReason: compliance.reason });
  }

  await debitCredits(userId, cost, 'video_ad', {
    relatedSiteId: opts.siteId,
    note: `video_ad:${opts.mode}:${opts.format}`,
  });

  const videoAd = await VideoAd.create({
    userId,
    siteId: opts.siteId || undefined,
    mode: opts.mode,
    format: opts.format,
    aspectRatio: opts.aspectRatio,
    brief: opts.brief,
    creditsCharged: cost,
    status: 'queued',
    scenes: [],
  });

  const bullJob = await pipelineQueue.add(
    'video_ad',
    { siteId: opts.siteId, userId, type: 'video_ad', videoAdId: String(videoAd._id) },
    { jobId: `video_${videoAd._id}_${Date.now()}` }
  );

  await JobModel.create({
    type: 'video_ad',
    siteId: site?._id,
    status: 'queued',
    bullJobId: String(bullJob.id),
    meta: { videoAdId: String(videoAd._id), mode: opts.mode, format: opts.format },
  });

  // Recommandation NON-bloquante : une 30s (~75 mots parlés) ne peut pas
  // détailler beaucoup d'offres distinctes. On ne bloque jamais la
  // génération pour ça (le client a le droit de vouloir une 30s même avec
  // un site fourni) — juste un signal que le frontend peut afficher comme
  // suggestion, après coup ou en pré-check.
  const formatRecommendation =
    opts.format === '30s' && dossier.offerHighlights.length > MANY_OFFERS_THRESHOLD
      ? `Ce site propose ${dossier.offerHighlights.length} offres distinctes détectées — un format 30s ne pourra en évoquer qu'une partie. Pour une couverture complète, envisagez 60s ou 120s.`
      : undefined;

  return {
    videoAdId: videoAd._id,
    jobId: bullJob.id,
    creditsCharged: cost,
    status: 'queued',
    formatRecommendation,
  };
}

/**
 * Relance corrective d'une vidéo livrée avec un défaut mineur (voir
 * processVideoAd / video-qc.service.ts). Débite le prix réduit (50% de
 * l'originale pour la 1ère relance, plein tarif au-delà), marque l'offre de
 * l'originale comme utilisée, et crée une NOUVELLE vidéo (même brief/mode/
 * format/site) qui repasse par le pipeline complet.
 *
 * Le client garde la vidéo d'origine (déjà livrée) et reçoit en plus cette
 * seconde vidéo une fois prête — aucune des deux n'est effacée.
 */
export async function enqueueVideoAdRelaunch(
  userId: string,
  originalVideoAdId: string
): Promise<{ videoAdId: unknown; jobId: unknown; creditsCharged: number; status: 'queued' }> {
  const original = await VideoAd.findById(originalVideoAdId);
  if (!original) throw new AppError('Vidéo introuvable', 404);
  if (String(original.userId) !== String(userId)) throw new AppError('Accès refusé', 403);

  if (original.status !== 'completed') {
    throw new AppError("Seule une vidéo livrée peut faire l'objet d'une relance corrective.", 400);
  }
  if (!original.relaunchOffer?.eligible) {
    throw new AppError("Cette vidéo n'a pas de défaut détecté ouvrant droit à une relance corrective.", 400);
  }
  if (original.relaunchOffer.used) {
    throw new AppError('Une relance corrective a déjà été utilisée pour cette vidéo.', 400);
  }

  const cost = original.relaunchOffer.priceCredits || getVideoAdRelaunchCost(original.creditsCharged, !original.isRelaunchOf);

  await debitCredits(userId, cost, 'video_ad_relance', {
    relatedSiteId: original.siteId,
    note: `video_ad_relance:${originalVideoAdId}`,
  });

  // Marquer l'offre d'origine comme consommée avant de créer la nouvelle vidéo,
  // pour éviter qu'un double-clic ne déclenche deux relances payantes.
  original.relaunchOffer.used = true;
  await original.save();

  const videoAd = await VideoAd.create({
    userId,
    siteId: original.siteId,
    mode: original.mode,
    format: original.format,
    aspectRatio: original.aspectRatio,
    brief: original.brief,
    creditsCharged: cost,
    status: 'queued',
    scenes: [],
    isRelaunchOf: original._id,
  });

  const bullJob = await pipelineQueue.add(
    'video_ad',
    { siteId: original.siteId, userId, type: 'video_ad', videoAdId: String(videoAd._id) },
    { jobId: `video_${videoAd._id}_${Date.now()}` }
  );

  await JobModel.create({
    type: 'video_ad',
    siteId: original.siteId,
    status: 'queued',
    bullJobId: String(bullJob.id),
    meta: { videoAdId: String(videoAd._id), mode: original.mode, format: original.format, isRelaunchOf: originalVideoAdId },
  });

  return {
    videoAdId: videoAd._id,
    jobId: bullJob.id,
    creditsCharged: cost,
    status: 'queued',
  };
}

/**
 * Flux Option 1 "voix off + musique" (mode = 'voix_off') :
 * - Pas de choix multi-scène côté Alexya : on génère 1 clip 10s par scène (mode
 *   "best", silencieux) et on concatène via ffmpeg.
 * - 1 retry auto par scène en cas d'échec. Si ça échoue encore → remboursement
 *   intégral, pas de vidéo livrée.
 * - Une fois le montage silencieux prêt : narration TTS (ElevenLabs, script
 *   généré par Claude) muxée sur la vidéo, puis musique de fond légère
 *   ajoutée par-dessus à bas volume (MUSIC_VOLUME_PRO) pour ne jamais couvrir
 *   la voix. Remplace l'ancien tier "avec_son" (narration Alexya intégrée) —
 *   un seul flux, moins cher, marge conservée.
 *
 * Flux Option 2 "Avatar" (mode = 'avatar_standard' | 'avatar_scenario') : voir
 * processAvatarVideoAd plus bas — portrait Grok Imagine + narration TTS +
 * lipsync FalAI Kling Avatar, pas de montage multi-scènes Alexya.
 */

const CLIPS_PER_FORMAT: Record<VideoAdFormat, number> = {
  '30s': 3,
  '60s': 6,
  '120s': 12,
};
const CLIP_DURATION_SECONDS = 10;

function buildDossierContext(brief: Record<string, unknown>): string {
  const dossierText = typeof (brief as any).siteContentDossier === 'string' ? (brief as any).siteContentDossier : '';
  if (!dossierText) return '';
  return `\nDossier de contenu complet du site (toutes les pages analysées) :
${dossierText}

Instruction impérative de couverture : identifie TOUTES les offres/services distincts présents dans ce dossier. La vidéo doit les couvrir ou au minimum les évoquer tous ensemble (ex: "que ce soit pour X, Y ou Z") — ne te concentre jamais sur une seule offre alors que le site en propose plusieurs, et n'invente jamais une offre absente du dossier.`;
}

function buildScenesPrompt(brief: Record<string, unknown>, niche: string, nbScenes: number): string {
  const siteMeta = (brief as any).siteMeta;
  const siteContext = siteMeta
    ? `\nContexte du site réel (analysé depuis l'URL fournie par le client) :
- Titre : ${siteMeta.title || 'N/A'}
- Description : ${siteMeta.description || 'N/A'}
- H1 : ${siteMeta.h1 || 'N/A'}
- Extrait : ${(siteMeta.snippet || '').slice(0, 400)}
Utilise ces informations pour personnaliser fortement la vidéo (branding, promesse, ton, univers visuel).`
    : '';
  const dossierContext = buildDossierContext(brief);

  return `Tu es le scénariste vidéo NexAI. Découpe une publicité de ${nbScenes} plans de 10 secondes chacun pour un site ${niche || 'général'}.
Brief client (JSON) : ${JSON.stringify({ ...brief, siteMeta: undefined, siteContentDossier: undefined })}
${siteContext}
${dossierContext}

Réponds en JSON strict uniquement, un tableau de ${nbScenes} objets :
[{"description": "description visuelle précise du plan (mouvement de caméra, sujet, ambiance, PAS de texte à l'écran)"}]

Chaque plan doit raconter une progression cohérente (accroche → démonstration → appel à l'action), pas ${nbScenes} plans déconnectés.
Si un site réel a été analysé, les plans doivent refléter fidèlement l'identité et le message de ce site.`;
}

async function buildImagePromptForScene(
  sceneDescription: string,
  brief: Record<string, unknown>,
  referenceKind?: ReferenceImage['kind']
): Promise<string> {
  // Claude Sonnet 5 rédige TOUJOURS le prompt image final
  const siteMeta = (brief as any).siteMeta;
  const brand = String((brief as { brandName?: string }).brandName || siteMeta?.title || '');

  // Si une image de référence sera passée à Grok Imagine (image-to-image), le
  // prompt doit décrire une TRANSFORMATION de cette image plutôt qu'une scène
  // générée de zéro — sinon Grok Imagine a tendance à ignorer la référence.
  const referenceInstruction =
    referenceKind === 'product'
      ? "\nUne photo produit RÉELLE du client sera fournie comme image de référence : le prompt doit décrire comment mettre en scène CE produit précis (angle, décor, lumière, contexte), sans en changer la forme ni les proportions. Ne décris pas un produit générique."
      : referenceKind === 'mockup'
        ? "\nUne photo d'ambiance (stock) sera fournie comme image de référence : le prompt doit décrire comment adapter cette ambiance/scène au ton de la marque, sans forcément représenter le produit exact."
        : '';

  const system = `Tu es un expert en prompts d'image pour génération vidéo IA.
Tu écris un prompt UNIQUE, précis, en anglais, pour une image de départ photoréaliste (start frame).
Règles strictes :
- Pas de texte, pas de watermark, pas de logo illisible
- Composition cinématique, éclairage professionnel
- Inclure la marque / l'univers du site si fourni
- 1 à 3 phrases maximum, très descriptif visuellement${referenceInstruction}
Réponds UNIQUEMENT avec le prompt, sans guillemets ni explication.`;

  const user = `Scène à illustrer : ${sceneDescription}
Marque / site : ${brand}
${siteMeta ? `Contexte site : titre=${siteMeta.title || ''} | desc=${(siteMeta.description || '').slice(0, 200)}` : ''}
Brief : ${JSON.stringify({ ...brief, siteMeta: undefined }).slice(0, 500)}`;

  try {
    const prompt = await callClaude('claude-sonnet-5', system, [{ role: 'user', content: user }], {
      maxTokens: 300,
      temperature: 0.4,
    });
    return prompt.trim().replace(/^["']|["']$/g, '');
  } catch {
    // fallback minimal si Claude indisponible
    return `Photorealistic cinematic start frame for a video ad. ${sceneDescription}. Brand: ${brand}. No text, no watermark, professional lighting.`;
  }
}

/**
 * Génère le script de narration (voix off) via Claude, calibré pour tenir
 * dans la durée cible de la vidéo (≈150 mots/min en français — voir
 * estimateSpeechDurationSeconds). Utilisé par l'Option 1 (voix_off) et par
 * l'Avatar (Standard + Scénario).
 */
async function buildNarrationScript(
  brief: Record<string, unknown>,
  niche: string,
  targetDurationSeconds: number
): Promise<string> {
  const siteMeta = (brief as any).siteMeta;
  const maxWords = Math.max(15, Math.round((targetDurationSeconds / 60) * 150));
  const siteContext = siteMeta
    ? `\nContexte du site réel : titre="${siteMeta.title || ''}", description="${(siteMeta.description || '').slice(0, 300)}"`
    : '';
  const dossierContext = buildDossierContext(brief);

  const system = `Tu es rédacteur publicitaire NexAI. Tu écris un script de voix off percutant, en français, prêt à être lu par une voix de synthèse.
Règles strictes :
- Maximum ${maxWords} mots (durée cible : ${targetDurationSeconds} secondes de lecture naturelle)
- Structure : accroche immédiate → bénéfice/promesse → appel à l'action clair à la fin
- Phrases courtes, rythme dynamique, pas de jargon
- Le texte lu porte l'essentiel de la couverture des offres (la vidéo ne peut montrer que quelques plans) : si plusieurs offres distinctes existent, regroupe-les intelligemment plutôt que de n'en citer qu'une seule par défaut
- Réponds UNIQUEMENT avec le texte du script, sans titre, guillemets ni explication`;

  const user = `Marque/site : ${String((brief as { brandName?: string }).brandName || siteMeta?.title || 'la marque')}
Niche : ${niche}
Brief client : ${JSON.stringify({ ...brief, siteMeta: undefined, siteContentDossier: undefined }).slice(0, 800)}${siteContext}${dossierContext}`;

  try {
    const script = await callClaude('claude-sonnet-5', system, [{ role: 'user', content: user }], {
      maxTokens: 400,
      temperature: 0.5,
    });
    return script.trim().replace(/^["']|["']$/g, '');
  } catch {
    return `Découvrez ${String((brief as { brandName?: string }).brandName || 'notre offre')} dès aujourd'hui. Une solution pensée pour vous. Ne manquez pas cette opportunité — passez à l'action maintenant.`;
  }
}

function parseScenesJson(raw: string, nbScenes: number): string[] {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Array<{ description: string }>;
    const descriptions = parsed.map((s) => s.description).filter(Boolean);
    if (descriptions.length >= 1) return descriptions.slice(0, nbScenes);
  } catch {
    // fallback ci-dessous
  }
  // Fallback : un seul plan générique répété si le JSON est invalide (évite un crash total)
  return Array.from({ length: nbScenes }, (_, i) => `Plan ${i + 1} générique pour la marque.`);
}

async function runFfmpegConcat(clipPaths: string[], outputPath: string): Promise<void> {
  const listFile = path.join(path.dirname(outputPath), `concat_${Date.now()}.txt`);
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listFile, listContent, 'utf-8');

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg concat échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });

  await fs.unlink(listFile).catch(() => {});
}

/**
 * Durée du fondu enchaîné (crossfade) entre chaque plan — logo compris.
 * 0,35s : assez visible pour casser le cut sec, assez court pour ne pas
 * ralentir le rythme d'une pub de 30s.
 */
const CROSSFADE_SECONDS = 0.35;

/** Léger étalonnage colorimétrique commun à TOUS les plans (IA, capture, logo)
 * — contraste/saturation très légèrement relevés — pour que l'ensemble ait
 * l'air d'appartenir au même univers visuel malgré des origines différentes
 * (généré vs capture réelle). Volontairement subtil : on ne veut pas que la
 * capture réelle perde son authenticité en paraissant trop "retouchée". */
const SHARED_GRADE_FILTER = 'eq=contrast=1.04:saturation=1.08:brightness=0.01';

interface CrossfadeClipInput {
  path: string;
  /** Durée normalisée à laquelle CE plan est forcé (trim si plus long,
   * complété en figeant la dernière image si plus court) — garantit une
   * durée totale déterministe, calculable sans sonder les fichiers réels. */
  durationSeconds: number;
  /** Uniquement pour le plan de capture réelle du site (Playwright) — insère
   * ce plan dans un cadre d'appareil plutôt qu'en plein écran brut, pour
   * qu'il se lise comme "voici vraiment leur site" plutôt que comme un
   * accident de montage entre deux plans stylisés.
   * 'browser' : cadre navigateur desktop (barre + points façon onglets) —
   *   utilisé en 16:9.
   * 'phone'   : cadre smartphone (bezel + encoche + barre d'accueil) —
   *   utilisé en 9:16, pour que la capture du site se lise comme "vu sur
   *   mobile" plutôt qu'un cadre desktop écrasé en portrait. */
  deviceFrame?: 'browser' | 'phone';
}

/**
 * Construit la chaîne de filtre pour UN plan donné : normalisation de durée,
 * mise à l'échelle vers la résolution cible commune (+ cadre navigateur pour
 * la capture réelle), étalonnage colorimétrique partagé. Séparée de
 * runFfmpegCrossfadeConcat uniquement pour rester lisible.
 */
function buildCrossfadeInputChain(
  idx: number,
  clip: CrossfadeClipInput,
  target: { width: number; height: number; fps: number }
): string {
  const { width, height, fps } = target;
  // tpad avant trim : si le fichier réel est légèrement plus court que la
  // durée normalisée voulue (ex: capture Playwright avec un peu moins de
  // frames que prévu), on gèle la dernière image plutôt que de laisser un
  // trou — sans jamais avoir besoin de sonder la durée réelle du fichier.
  const base = `[${idx}:v]tpad=stop_mode=clone:stop_duration=2,trim=duration=${clip.durationSeconds}:start=0,setpts=PTS-STARTPTS`;

  if (!clip.deviceFrame) {
    return (
      `${base},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `${SHARED_GRADE_FILTER},fps=${fps},format=yuv420p,setsar=1[v${idx}]`
    );
  }

  if (clip.deviceFrame === 'browser') {
    // Cadre "navigateur" : la capture est réduite et centrée dans une zone
    // intérieure, avec une barre de chrome sombre en haut (3 points façon
    // onglets) et une fine bordure — signale visuellement "ceci est une vraie
    // page web", plutôt qu'un plein cadre qui ressemble à un enregistrement
    // d'écran accidentel entre deux plans stylisés.
    const topBar = Math.round(height * 0.055);
    const margin = Math.round(width * 0.035);
    let innerW = width - margin * 2;
    let innerH = height - topBar - margin;
    innerW -= innerW % 2;
    innerH -= innerH % 2;
    const offX = margin;
    const offY = topBar;
    const dotR = Math.max(6, Math.round(topBar * 0.28));
    const dotY = Math.round(topBar / 2 - dotR / 2);
    const dotX0 = Math.round(width * 0.025);
    const dotGap = dotR + Math.round(width * 0.02);

    return (
      `${base},scale=${innerW}:${innerH}:force_original_aspect_ratio=increase,` +
      `crop=${innerW}:${innerH},setsar=1[inner${idx}];` +
      `[inner${idx}]pad=${width}:${height}:${offX}:${offY}:color=0x1c1f26[padded${idx}];` +
      `[padded${idx}]drawbox=x=${offX - 2}:y=${offY - 2}:w=${innerW + 4}:h=${innerH + 4}:color=white@0.15:t=2[bord${idx}];` +
      `[bord${idx}]drawbox=x=${dotX0}:y=${dotY}:w=${dotR}:h=${dotR}:color=0xFF5F57:t=fill[dd1_${idx}];` +
      `[dd1_${idx}]drawbox=x=${dotX0 + dotGap}:y=${dotY}:w=${dotR}:h=${dotR}:color=0xFEBC2E:t=fill[dd2_${idx}];` +
      `[dd2_${idx}]drawbox=x=${dotX0 + dotGap * 2}:y=${dotY}:w=${dotR}:h=${dotR}:color=0x28C840:t=fill[dd3_${idx}];` +
      `[dd3_${idx}]${SHARED_GRADE_FILTER},fps=${fps},format=yuv420p[v${idx}]`
    );
  }

  // Cadre "téléphone" : utilisé quand la vidéo finale est en 9:16 — la
  // capture est réduite dans une zone intérieure façon écran de smartphone,
  // avec un bezel sombre arrondi, une encoche en haut et une barre d'accueil
  // en bas. Évite qu'un cadre navigateur desktop (pensé pour du 16:9) soit
  // simplement écrasé en portrait, ce qui casse la crédibilité du plan.
  const bezel = Math.round(width * 0.045);
  const topInset = Math.round(height * 0.035);
  const bottomInset = Math.round(height * 0.045);
  let innerW = width - bezel * 2;
  let innerH = height - topInset - bottomInset;
  innerW -= innerW % 2;
  innerH -= innerH % 2;
  const offX = bezel;
  const offY = topInset;
  const notchW = Math.round(innerW * 0.34);
  const notchH = Math.max(8, Math.round(topInset * 0.45));
  const notchX = Math.round(offX + (innerW - notchW) / 2);
  const notchY = Math.max(0, offY - notchH + 2);
  const barW = Math.round(innerW * 0.32);
  const barH = Math.max(4, Math.round(bottomInset * 0.22));
  const barX = Math.round(offX + (innerW - barW) / 2);
  const barY = Math.round(height - bottomInset / 2 - barH / 2);

  return (
    `${base},scale=${innerW}:${innerH}:force_original_aspect_ratio=increase,` +
    `crop=${innerW}:${innerH},setsar=1[inner${idx}];` +
    `[inner${idx}]pad=${width}:${height}:${offX}:${offY}:color=0x0b0d10[padded${idx}];` +
    `[padded${idx}]drawbox=x=${offX - 3}:y=${offY - 3}:w=${innerW + 6}:h=${innerH + 6}:color=white@0.12:t=3[bord${idx}];` +
    `[bord${idx}]drawbox=x=${notchX}:y=${notchY}:w=${notchW}:h=${notchH}:color=0x0b0d10:t=fill[notch${idx}];` +
    `[notch${idx}]drawbox=x=${barX}:y=${barY}:w=${barW}:h=${barH}:color=white@0.55:t=fill[bar${idx}];` +
    `[bar${idx}]${SHARED_GRADE_FILTER},fps=${fps},format=yuv420p[v${idx}]`
  );
}

/**
 * Remplace l'ancien concat brut (cut sec) par un enchaînement en fondu
 * (xfade) entre TOUS les plans, logo d'intro compris — un seul montage
 * cohérent plutôt qu'un logo à part + un concat séparé pour le reste.
 * Chaque durée d'entrée étant normalisée (voir buildCrossfadeInputChain), la
 * durée totale finale est calculable précisément en JS (utile pour caler la
 * narration et le CTA), sans avoir besoin de sonder le fichier de sortie.
 */
async function runFfmpegCrossfadeConcat(
  clips: CrossfadeClipInput[],
  outputPath: string,
  target: { width: number; height: number; fps: number }
): Promise<{ totalDurationSeconds: number }> {
  if (clips.length === 0) {
    throw new AppError('Aucun plan à monter (liste de clips vide).', 500);
  }

  const args: string[] = ['-y'];
  for (const c of clips) args.push('-i', c.path);

  const inputChains = clips.map((c, idx) => buildCrossfadeInputChain(idx, c, target));

  let filterComplex: string;
  let outLabel: string;
  let totalDurationSeconds: number;

  if (clips.length === 1) {
    filterComplex = inputChains.join(';');
    outLabel = 'v0';
    totalDurationSeconds = clips[0].durationSeconds;
  } else {
    const xfadeParts: string[] = [];
    let prevLabel = 'v0';
    let cumulative = clips[0].durationSeconds;
    for (let i = 1; i < clips.length; i++) {
      const offset = cumulative - CROSSFADE_SECONDS;
      const label = i < clips.length - 1 ? `x${i}` : 'outv';
      xfadeParts.push(
        `[${prevLabel}][v${i}]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${offset.toFixed(3)}[${label}]`
      );
      cumulative = cumulative + clips[i].durationSeconds - CROSSFADE_SECONDS;
      prevLabel = label;
    }
    filterComplex = `${inputChains.join(';')};${xfadeParts.join(';')}`;
    outLabel = 'outv';
    totalDurationSeconds = cumulative;
  }

  args.push(
    '-filter_complex', filterComplex,
    '-map', `[${outLabel}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    outputPath
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg montage (crossfade) échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });

  return { totalDurationSeconds };
}

function escapeDrawtext(text: string): string {
  // Échappe les caractères qui cassent la syntaxe du filtre drawtext ffmpeg.
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Tier Standard : mixe une piste musicale libre de droits (loopée puis coupée
 * à la durée de la vidéo) et incruste un overlay texte (nom de marque en
 * watermark permanent + call-to-action dans les 3 dernières secondes).
 * Ré-encode forcément (drawtext ne fonctionne pas en stream-copy).
 * Si aucune musique n'est configurée pour la niche (URL vide), on incruste
 * quand même le texte mais sans piste audio ajoutée.
 */
/** Construit une ligne courte "Offre 1 • Offre 2 • Offre 3" à partir des
 * offres détectées par site-content-analysis.service.ts — affichée à
 * l'écran en overlay. Le texte lu (voix off) reste la source principale de
 * couverture, mais un texte affiché est plus dense en information que la
 * voix dans un temps imparti court : ça permet de "montrer" des offres que
 * le script parlé n'a pas eu la place de toutes développer. */
function buildOffersOverlayLine(offerHighlights?: string[]): string {
  if (!offerHighlights?.length) return '';
  return offerHighlights.slice(0, 3).join('  •  ').slice(0, 70);
}

async function runFfmpegMixMusicAndOverlay(params: {
  silentVideoPath: string;
  musicPath: string | null;
  totalDurationSeconds: number;
  brandName?: string;
  ctaText?: string;
  offerHighlights?: string[];
  outputPath: string;
}): Promise<void> {
  const { silentVideoPath, musicPath, totalDurationSeconds, outputPath } = params;
  const brand = params.brandName ? escapeDrawtext(params.brandName.slice(0, 40)) : '';
  const cta = escapeDrawtext((params.ctaText || 'Découvrez-en plus').slice(0, 60));
  const offersLine = escapeDrawtext(buildOffersOverlayLine(params.offerHighlights));
  const fontPath = env.FFMPEG_FONT_PATH;
  const ctaStart = Math.max(0, totalDurationSeconds - 3);
  // Fenêtre d'affichage des offres : après l'accroche (1s), jusqu'à 6s ou
  // jusqu'à 2s avant la fin si la vidéo est très courte — jamais superposé
  // au CTA final.
  const offersEnd = Math.max(2, Math.min(6, totalDurationSeconds - 2));

  const args: string[] = ['-y', '-i', silentVideoPath];
  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  let videoLabel = '0:v';
  const filters: string[] = [];

  if (brand) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${brand}':fontcolor=white:fontsize=28:` +
        `x=32:y=h-64:box=1:boxcolor=black@0.35:boxborderw=10[vbrand]`
    );
    videoLabel = 'vbrand';
  }

  if (offersLine && offersEnd > 1) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${offersLine}':fontcolor=white:fontsize=22:` +
        `x=(w-text_w)/2:y=48:box=1:boxcolor=black@0.4:boxborderw=8:enable='between(t,1,${offersEnd})'[voffers]`
    );
    videoLabel = 'voffers';
  }

  filters.push(
    `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${cta}':fontcolor=white:fontsize=36:` +
      `x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.45:boxborderw=14:enable='gte(t,${ctaStart})'[vout]`
  );

  const mapArgs: string[] = ['-map', '[vout]'];

  if (musicPath) {
    filters.push(`[1:a]volume=${env.MUSIC_VOLUME}[aout]`);
    mapArgs.push('-map', '[aout]');
  }

  args.push('-filter_complex', filters.join(';'), ...mapArgs);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (musicPath) args.push('-c:a', 'aac', '-shortest');
  args.push('-t', String(totalDurationSeconds), outputPath);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg mix (musique/overlay) échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });
}

/**
 * Tier "avec_son" : le clip a déjà une narration/ambiance générée par Alexya
 * (mode cinematic, sound_enabled). On ajoute UNIQUEMENT une musique de fond à
 * bas volume par-dessus, sans toucher à l'image (copie du flux vidéo, pas de
 * ré-encodage vidéo) ni retoucher la voix. `duration=first` + `-shortest`
 * garantissent que le morceau (loopé) est coupé à la durée exacte de la vidéo.
 */
async function runFfmpegMixBackgroundMusicUnderVoice(params: {
  videoWithVoicePath: string;
  musicPath: string;
  outputPath: string;
  /** Surcharge ponctuelle du facteur musique (retry QC voix/musique) — sinon env.MUSIC_VOLUME_PRO. */
  musicVolumeOverride?: number;
}): Promise<void> {
  const { videoWithVoicePath, musicPath, outputPath, musicVolumeOverride } = params;
  const musicVolume = musicVolumeOverride ?? env.MUSIC_VOLUME_PRO;

  const args = [
    '-y',
    '-i', videoWithVoicePath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex',
    // Normalisation finale (loudnorm) après le mix voix+musique : garantit un
    // volume perçu constant d'une vidéo à l'autre, indépendamment de la
    // combinaison voix/musique tirée au hasard.
    `[1:a]volume=${musicVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[premix];[premix]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg mix musique de fond échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });
}

/**
 * Mux la narration TTS sur une vidéo silencieuse : piste vidéo copiée telle
 * quelle, piste audio = narration, complétée par du silence (apad) si elle
 * est plus courte que la vidéo, puis coupée à la durée exacte de la vidéo
 * (-t) si elle est plus longue. Résultat réutilisable directement par
 * runFfmpegMixBackgroundMusicUnderVoice (même contrat que l'ancienne sortie
 * Alexya "cinematic + son").
 */
async function runFfmpegAddNarration(params: {
  silentVideoPath: string;
  narrationAudioPath: string;
  totalDurationSeconds: number;
  outputPath: string;
}): Promise<void> {
  const { silentVideoPath, narrationAudioPath, totalDurationSeconds, outputPath } = params;

  const args = [
    '-y',
    '-i', silentVideoPath,
    '-i', narrationAudioPath,
    // loudnorm avant apad : chaque voix ElevenLabs a un volume perçu différent
    // selon la voix tirée dans le pool — on normalise à un niveau broadcast
    // standard (-16 LUFS) pour un rendu constant quelle que soit la voix.
    '-filter_complex', '[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]',
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-t', String(totalDurationSeconds),
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg mux narration échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });
}

/**
 * URL réellement capturable pour le plan "capture réelle" du mixte :
 * - soit l'URL externe fournie par le client (brief.siteUrl, déjà validée
 *   et enrichie en siteMeta.url à l'enqueue),
 * - soit le site NexAI lié (sous-domaine ou domaine personnalisé déjà
 *   attaché), s'il en a un.
 * Retourne null si aucune URL live n'est disponible — dans ce cas le plan
 * "capture réelle" est simplement remplacé par un plan généré par IA comme
 * avant (pas de dégradation, juste pas de bonus).
 */
async function resolveLiveSiteUrl(videoAd: HydratedDocument<any>): Promise<string | null> {
  const siteMeta = (videoAd.brief as any)?.siteMeta;
  if (siteMeta?.url) return siteMeta.url;

  if (videoAd.siteId) {
    const site = await Site.findById(videoAd.siteId);
    if (site?.domainName) return `https://${site.domainName}`;
  }

  return null;
}

/**
 * Résolution/fps cible commune à tous les plans du montage, quelle que soit
 * leur origine (Alexya, capture Playwright, clip logo statique) — chaque
 * clip est mis à l'échelle vers cette cible au montage (voir
 * runFfmpegCrossfadeConcat), donc on n'a plus besoin de deviner/sonder la
 * résolution native d'un fournisseur pour que tout s'assemble proprement.
 */
const TARGET_VIDEO_RESOLUTIONS: Record<'16:9' | '9:16', { width: number; height: number; fps: number }> = {
  '16:9': { width: 1280, height: 720, fps: 30 },
  '9:16': { width: 720, height: 1280, fps: 30 },
};
function getTargetResolution(aspectRatio: '16:9' | '9:16') {
  return TARGET_VIDEO_RESOLUTIONS[aspectRatio] || TARGET_VIDEO_RESOLUTIONS['16:9'];
}

const LOGO_INTRO_DURATION_SECONDS = 1.5;

/**
 * Transforme l'image du logo en un court clip vidéo (fondu d'entrée),
 * calé sur la résolution/fps cible commune (getTargetResolution) — le
 * montage (runFfmpegCrossfadeConcat) remet de toute façon chaque clip à
 * l'échelle, donc pas besoin de sonder quoi que ce soit ici.
 */
async function runFfmpegBuildLogoIntroClip(params: {
  logoImagePath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
}): Promise<void> {
  const { logoImagePath, outputPath, width, height, fps } = params;
  // Fondu d'entrée uniquement (0.3s, ouverture propre depuis le noir) — pas
  // de fondu de sortie : la transition vers le plan suivant est maintenant
  // gérée par le crossfade global (runFfmpegCrossfadeConcat), un fondu de
  // sortie ici l'assombrirait en double.

  const args = [
    '-y',
    '-loop', '1',
    '-i', logoImagePath,
    '-t', String(LOGO_INTRO_DURATION_SECONDS),
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,fade=t=in:st=0:d=0.3`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg clip intro logo échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });
}

/**
 * Incruste le nom de marque (watermark discret, permanent) et un CTA
 * ("Visitez [site]", etc.) dans les 3 dernières secondes, sur la vidéo déjà
 * finalisée (narration + musique mixées). Contrairement à
 * runFfmpegMixMusicAndOverlay (non branchée, conçue pour un flux plus ancien
 * sans narration séparée), celle-ci s'applique en toute dernière étape et
 * préserve l'audio existant tel quel (-c:a copy).
 */
async function runFfmpegAddCtaOverlay(params: {
  inputPath: string;
  outputPath: string;
  totalDurationSeconds: number;
  brandName?: string;
  ctaText?: string;
  offerHighlights?: string[];
}): Promise<void> {
  const { inputPath, outputPath, totalDurationSeconds } = params;
  const brand = params.brandName ? escapeDrawtext(params.brandName.slice(0, 40)) : '';
  const cta = escapeDrawtext((params.ctaText || 'Découvrez-en plus').slice(0, 60));
  const offersLine = escapeDrawtext(buildOffersOverlayLine(params.offerHighlights));
  const fontPath = env.FFMPEG_FONT_PATH;
  const ctaStart = Math.max(0, totalDurationSeconds - 3);
  const offersEnd = Math.max(2, Math.min(6, totalDurationSeconds - 2));

  const filters: string[] = [];
  let videoLabel = '0:v';

  if (brand) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${brand}':fontcolor=white:fontsize=28:` +
        `x=32:y=h-64:box=1:boxcolor=black@0.35:boxborderw=10[vbrand]`
    );
    videoLabel = 'vbrand';
  }

  if (offersLine && offersEnd > 1) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${offersLine}':fontcolor=white:fontsize=22:` +
        `x=(w-text_w)/2:y=48:box=1:boxcolor=black@0.4:boxborderw=8:enable='between(t,1,${offersEnd})'[voffers]`
    );
    videoLabel = 'voffers';
  }

  filters.push(
    `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${cta}':fontcolor=white:fontsize=36:` +
      `x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.45:boxborderw=14:enable='gte(t,${ctaStart})'[vout]`
  );

  const args = [
    '-y', '-i', inputPath,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError(`ffmpeg overlay CTA échoué (code ${code}): ${stderr.slice(-500)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable ou erreur: ${err.message}`, 500)));
  });
}

async function downloadToTmp(url: string, filename: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new AppError(`Téléchargement clip échoué (${res.status})`, 502);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filePath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Résout le logo à utiliser dans la vidéo, sans jamais demander d'étape
 * manuelle au client (décision produit validée) :
 * 1. Logo extrait automatiquement du vrai site (site-meta.service) si un
 *    site réel a été analysé et que l'image détectée charge réellement.
 * 2. Sinon (pas de site, ou logo non détecté/cassé) : génération IA via
 *    Recraft, en dernier recours, pour garantir que le client a toujours un
 *    résultat de qualité. On prend la 1ère des 3 propositions.
 * Le logo retenu est utilisé tel quel (Option A) — pas de retouche IA.
 */
async function resolveBrandLogo(
  brief: Record<string, unknown>,
  niche: string
): Promise<{ url: string; source: 'site' | 'generated' } | null> {
  const siteMeta = (brief as any)?.siteMeta;
  const candidateLogoUrl = siteMeta?.logoUrl as string | undefined;

  if (candidateLogoUrl && (await verifyImageUrl(candidateLogoUrl))) {
    return { url: candidateLogoUrl, source: 'site' };
  }

  const brandName = String((brief as { brandName?: string }).brandName || siteMeta?.title || niche || 'Marque').slice(0, 60);

  try {
    const proposals = await generateLogoProposals({ brandName, niche });
    if (proposals[0]?.url) {
      return { url: proposals[0].url, source: 'generated' };
    }
  } catch (err) {
    // Le logo est un "plus", jamais un bloquant : si même la génération IA
    // échoue, on livre la vidéo sans intro logo plutôt que de la faire échouer.
    console.warn('[video-pipeline] Résolution du logo indisponible, vidéo livrée sans intro logo', err);
  }

  return null;
}

/**
 * Traite une génération de vidéo pub de bout en bout. Appelé par le worker BullMQ.
 * Le débit crédits a déjà eu lieu à l'enqueue (voir enqueueVideoAd) ; ici on
 * rembourse intégralement en cas d'échec définitif (après le retry auto).
 * Dispatch selon videoAd.mode vers le bon pipeline (Option 1 voix off, ou
 * Option 2 avatar) — la logique de statut/remboursement est commune aux deux.
 */
export async function processVideoAd(videoAdId: string): Promise<void> {
  const videoAd = await VideoAd.findById(videoAdId);
  if (!videoAd) throw new Error(`VideoAd ${videoAdId} introuvable`);

  let niche = 'général';
  if (videoAd.siteId) {
    const site = await Site.findById(videoAd.siteId);
    if (site) niche = site.niche || niche;
  }
  // Si le brief contient déjà un siteMeta (URL externe), on peut en déduire une niche soft
  const meta = (videoAd.brief as any)?.siteMeta;
  if (meta?.title && niche === 'général') {
    niche = String(meta.title).slice(0, 40);
  }

  // Intro logo : uniquement pour l'Option 1 "voix off" (mixte discuté).
  // Le pipeline Avatar n'est pas concerné par cette correction.
  if (videoAd.mode === 'voix_off') {
    const logo = await resolveBrandLogo(videoAd.brief, niche);
    if (logo) {
      videoAd.logoUrl = logo.url;
      videoAd.logoSource = logo.source;
    }
  }

  videoAd.status = 'generating';
  await videoAd.save();

  const tmpFiles: string[] = [];

  try {
    const finalPath =
      videoAd.mode === 'voix_off'
        ? await runVoixOffPipeline(videoAd, videoAdId, niche, tmpFiles)
        : await runAvatarPipeline(videoAd, videoAdId, niche, tmpFiles);

    // Contrôle qualité final, juste avant l'upload/livraison client : durée
    // conforme, ratio conforme, pistes vidéo+audio réellement présentes et
    // non silencieuses. Deux issues possibles (voir video-qc.service.ts) :
    // - panne dure (blockingIssues non vide) → on jette nous-mêmes ci-dessous
    //   pour retomber dans le catch → remboursement automatique, rien n'est livré.
    // - défaut mineur seulement (minorIssues) → la vidéo EST livrée, avec un
    //   badge "résultat perfectible" et une offre de relance corrective à
    //   moitié prix (voir POST /video-ads/:id/relancer).
    const expectedDurationSeconds = parseInt(videoAd.format, 10) || 0;
    const qc = await evaluateFinalVideoIntegrity({
      filePath: finalPath,
      expectedDurationSeconds,
      expectedAspectRatio: videoAd.aspectRatio,
    });

    if (qc.blockingIssues.length > 0) {
      throw new AppError(
        `Contrôle qualité vidéo échoué avant livraison : ${qc.blockingIssues.join(' ; ')}`,
        500,
        { qcIssues: qc.blockingIssues, probe: qc.probe }
      );
    }

    if (qc.minorIssues.length > 0) {
      console.warn(
        `[video-pipeline] QC final pour ${videoAdId} : défaut(s) mineur(s) détecté(s), livraison avec badge — ${qc.minorIssues.join(' ; ')}`
      );
    } else {
      console.log(
        `[video-pipeline] QC final OK pour ${videoAdId} : durée=${qc.probe.durationSeconds?.toFixed(2)}s, ` +
          `résolution=${qc.probe.width}x${qc.probe.height}, audio=${qc.audioMeanVolumeDb.toFixed(1)}dB`
      );
    }

    const finalBuffer = await fs.readFile(finalPath);
    const uploaded = await uploadVideoAd(finalBuffer, `video_ad_${videoAdId}`);

    videoAd.finalVideoUrl = uploaded.url;
    videoAd.status = 'completed';
    videoAd.qcReport = {
      durationSeconds: qc.probe.durationSeconds,
      width: qc.probe.width,
      height: qc.probe.height,
      audioMeanVolumeDb: qc.audioMeanVolumeDb,
      checkedAt: new Date(),
      degraded: qc.minorIssues.length > 0,
      minorIssues: qc.minorIssues,
    };

    // Offre de relance corrective : uniquement si la vidéo a un défaut
    // mineur. Tarif réduit (50%) seulement pour la toute première vidéo
    // d'une chaîne (isRelaunchOf absent) — une relance qui ressort elle-même
    // dégradée n'ouvre droit qu'à une relance à prix plein.
    if (qc.minorIssues.length > 0) {
      const isFirstRelaunch = !videoAd.isRelaunchOf;
      videoAd.relaunchOffer = {
        eligible: true,
        used: false,
        priceCredits: getVideoAdRelaunchCost(videoAd.creditsCharged, isFirstRelaunch),
      };
    }

    await videoAd.save();

    console.log(`[video-pipeline] Vidéo ${videoAdId} (${videoAd.mode}) livrée : ${uploaded.url}`);
  } catch (err) {
    // Échec définitif (scène irrécupérable, ffmpeg, ou upload) → remboursement intégral, aucune vidéo livrée
    console.error(`[video-pipeline] Échec vidéo ${videoAdId}`, err);
    videoAd.status = 'failed';
    videoAd.errorMessage = (err as Error).message?.slice(0, 500);
    await videoAd.save();

    await creditCredits(videoAd.userId, videoAd.creditsCharged, 'video_ad', {
      relatedSiteId: videoAd.siteId,
      note: `remboursement_video_ad_echec:${videoAdId}`,
    });
    videoAd.status = 'refunded';
    await videoAd.save();
  } finally {
    await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})));
  }
}

/**
 * Option 1 — "Voix off + musique" : découpage Alexya multi-scènes (mode
 * "best", silencieux), narration TTS générée par-dessus, puis musique de
 * fond légère. Retourne le chemin local du fichier vidéo final (avant upload).
 */
async function runVoixOffPipeline(
  videoAd: HydratedDocument<any>,
  videoAdId: string,
  niche: string,
  tmpFiles: string[]
): Promise<string> {
  const nbScenes = CLIPS_PER_FORMAT[videoAd.format as VideoAdFormat];
    const scenesRaw = await callClaude(
      'claude-sonnet-5',
      'Tu réponds uniquement en JSON valide, sans texte autour.',
      [{ role: 'user', content: buildScenesPrompt(videoAd.brief, niche, nbScenes) }],
      { maxTokens: 3000, temperature: 0.6 }
    );
    const descriptions = parseScenesJson(scenesRaw, nbScenes);

    videoAd.scenes = descriptions.map((description, i) => ({
      index: i,
      prompt: description,
      durationSeconds: CLIP_DURATION_SECONDS,
      status: 'pending',
    }));
    await videoAd.save();

    // URL live résolue une seule fois — réutilisée pour la capture réelle
    // (Playwright) ET pour l'extraction des vraies photos produit du site
    // (voir product-image-sourcing.service.ts).
    const liveSiteUrl = await resolveLiveSiteUrl(videoAd);

    // Plan "capture réelle" (mixte) : si une vraie URL de site est
    // disponible, on capture un scroll réel (Playwright) pour en faire un
    // des plans, à côté des plans générés par IA. Best-effort total : en
    // cas d'échec (site inaccessible, timeout...), ce plan reste 100% IA
    // comme avant, la génération de la vidéo n'est jamais impactée.
    let captureClipLocalPath: string | null = null;
    const captureSceneIndex = nbScenes >= 2 ? 1 : -1; // "démonstration", juste après l'accroche
    if (captureSceneIndex >= 0 && liveSiteUrl) {
      try {
        const target = getTargetResolution(videoAd.aspectRatio);
        const capture = await captureSiteScreencast({
          url: liveSiteUrl,
          width: target.width,
          height: target.height,
          jobId: videoAdId,
        });
        captureClipLocalPath = capture.videoPath;
        tmpFiles.push(captureClipLocalPath);
      } catch (err) {
        console.warn(`[video-pipeline] Capture réelle du site indisponible, ce plan sera généré par IA`, err);
      }
    }
    const usedCaptureScene = !!captureClipLocalPath;

    // Pool d'images de référence pour les plans IA (image-to-image) : vraies
    // photos produit (site scrappé + uploads client) + mockups Pexels
    // (réutilisés d'un site NexAI existant, ou nouvellement sourcés pour un
    // site externe). Best-effort — un pool vide fait retomber la génération
    // sur le comportement 100% text-to-image d'avant cette fonctionnalité.
    const briefForImages = videoAd.brief as {
      brandName?: string;
      description?: string;
      style?: string;
      siteMeta?: { title?: string; description?: string };
      clientProductImageUrls?: string[];
    };
    let referencePool: ReferenceImagePool = { productImages: [], mockupImages: [] };
    try {
      referencePool = await buildReferenceImagePool({
        siteId: videoAd.siteId ? String(videoAd.siteId) : undefined,
        liveSiteUrl,
        clientUploadedImageUrls: briefForImages.clientProductImageUrls,
        niche,
        brandName: briefForImages.brandName || briefForImages.siteMeta?.title,
        description: briefForImages.description || briefForImages.siteMeta?.description,
        tone: briefForImages.style,
      });
    } catch (err) {
      // Ne devrait normalement jamais arriver (buildReferenceImagePool est
      // déjà best-effort en interne) — filet de sécurité supplémentaire.
      console.warn('[video-pipeline] Pool d\'images de référence indisponible, scènes en text-to-image pur', err);
    }
    videoAd.imageSourcing = {
      productImagesCount: referencePool.productImages.length,
      mockupImagesCount: referencePool.mockupImages.length,
      mockupReused: referencePool.mockupImages.some((img) => img.source === 'nexai_reuse'),
    };
    await videoAd.save();

    // File d'images de référence à distribuer aux scènes IA, produits
    // d'abord (plus impactant commercialement qu'un simple mockup
    // d'ambiance), mockups ensuite en complément/embellissement — cyclique
    // si moins d'images que de scènes.
    const referenceQueue: ReferenceImage[] = [...referencePool.productImages, ...referencePool.mockupImages];
    let referenceCursor = 0;
    function nextReferenceImage(): ReferenceImage | null {
      if (referenceQueue.length === 0) return null;
      const ref = referenceQueue[referenceCursor % referenceQueue.length];
      referenceCursor += 1;
      return ref;
    }

    const clipLocalPaths: string[] = [];

    for (let i = 0; i < videoAd.scenes.length; i++) {
      const scene = videoAd.scenes[i];

      // Plan "capture réelle" déjà obtenu avant la boucle : on l'utilise
      // directement, pas de génération IA pour cette scène.
      if (i === captureSceneIndex && captureClipLocalPath) {
        scene.status = 'generating';
        await videoAd.save();
        try {
          const buffer = await fs.readFile(captureClipLocalPath);
          const uploaded = await uploadVideoAd(buffer, `${videoAdId}_scene${i}_capture`);
          scene.clipUrl = uploaded.url;
          scene.source = 'capture';
          scene.status = 'completed';
          await videoAd.save();
          clipLocalPaths.push(captureClipLocalPath);
          continue;
        } catch (err) {
          // Upload de traçabilité seulement — si ça échoue, on utilise quand
          // même le fichier local déjà capturé pour le montage.
          console.warn(`[video-pipeline] Upload de traçabilité (scène capture) indisponible`, err);
          scene.source = 'capture';
          scene.status = 'completed';
          await videoAd.save();
          clipLocalPaths.push(captureClipLocalPath);
          continue;
        }
      }

      let lastError: string | undefined;
      let succeeded = false;

      // Image de référence pour ce plan (produit réel ou mockup) — figée une
      // fois par scène (même si retry) pour que le retry reproduise la même
      // intention visuelle plutôt que de retirer une image différente.
      const reference = nextReferenceImage();

      // 1 tentative + 1 retry automatique (décision validée)
      for (let attempt = 0; attempt < 2 && !succeeded; attempt++) {
        try {
          scene.status = 'generating';
          if (attempt === 1) scene.retried = true;
          await videoAd.save();

          const startImagePrompt = await buildImagePromptForScene(scene.prompt, videoAd.brief, reference?.kind);
          const generatedStart = await generateGrokImagine({
            prompt: startImagePrompt,
            aspectRatio: videoAd.aspectRatio,
            imageUrl: reference?.url,
          });
          const alexyaStartUrl = await uploadVideoStartFrameFromUrl(generatedStart.url);
          if (reference) {
            scene.referenceImageUrl = reference.url;
            scene.referenceImageKind = reference.kind;
          }

          // Option 1 unifiée : toujours mode "best" silencieux (Alexya) — la
          // voix vient désormais de la narration TTS ajoutée après montage
          // (plus de tier "cinematic + sound_enabled" côté Alexya).
          const clip = await generateAlexyaVideoClip({
            prompt: scene.prompt,
            mode: 'best',
            duration: CLIP_DURATION_SECONDS,
            startImageUrl: alexyaStartUrl,
            soundEnabled: false,
          });

          scene.clipUrl = clip.outputUrl;
          scene.source = 'ai';
          scene.status = 'completed';
          succeeded = true;
          await videoAd.save();

          const localPath = await downloadToTmp(clip.outputUrl, `${videoAdId}_scene${i}.mp4`);
          tmpFiles.push(localPath);
          clipLocalPaths.push(localPath);
        } catch (err) {
          lastError = (err as Error).message;
          console.warn(`[video-pipeline] Scène ${i} tentative ${attempt + 1} échouée`, err);
        }
      }

      if (!succeeded) {
        scene.status = 'failed';
        scene.error = lastError;
        await videoAd.save();
        throw new AppError(`Scène ${i} échouée après retry : ${lastError}`, 502);
      }
    }

    // Montage ffmpeg : enchaînement en fondu (crossfade) de tous les plans,
    // logo d'intro compris — voir runFfmpegCrossfadeConcat. Le plan de
    // capture réelle (s'il existe) est inséré dans un cadre "navigateur"
    // plutôt qu'en plein écran brut.
    const concatPath = path.join(os.tmpdir(), `${videoAdId}_concat.mp4`);
    tmpFiles.push(concatPath);
    const target = getTargetResolution(videoAd.aspectRatio);

    const crossfadeClips: CrossfadeClipInput[] = [];
    if (videoAd.logoUrl) {
      try {
        const logoImagePath = await downloadToTmp(videoAd.logoUrl, `${videoAdId}_logo_src`);
        tmpFiles.push(logoImagePath);

        const logoIntroPath = path.join(os.tmpdir(), `${videoAdId}_logo_intro.mp4`);
        tmpFiles.push(logoIntroPath);
        await runFfmpegBuildLogoIntroClip({
          logoImagePath,
          outputPath: logoIntroPath,
          width: target.width,
          height: target.height,
          fps: target.fps,
        });
        crossfadeClips.push({ path: logoIntroPath, durationSeconds: LOGO_INTRO_DURATION_SECONDS });
      } catch (err) {
        // Le logo est un "plus" : s'il échoue, on livre la vidéo sans intro
        // logo plutôt que de faire échouer toute la génération.
        console.warn(`[video-pipeline] Intro logo indisponible, montage sans logo`, err);
      }
    }
    clipLocalPaths.forEach((p, i) => {
      const isCaptureClip = usedCaptureScene && i === captureSceneIndex;
      crossfadeClips.push({
        path: p,
        durationSeconds: CLIP_DURATION_SECONDS,
        deviceFrame: isCaptureClip ? (videoAd.aspectRatio === '9:16' ? 'phone' : 'browser') : undefined,
      });
    });

    const { totalDurationSeconds } = await runFfmpegCrossfadeConcat(crossfadeClips, concatPath, target);

    // Narration TTS : script généré par Claude, calibré sur la durée totale,
    // synthétisé en voix off (remplace l'ancienne narration Alexya intégrée
    // du tier "avec_son" — un seul flux pour toute l'Option 1 désormais).
    let videoWithVoicePath = concatPath;
    // Conservé hors du bloc try pour le contrôle qualité voix/musique plus bas
    // (vérifier l'équilibre voix/musique n'a de sens que si une voix a bien
    // été générée — sinon rien à comparer, la vidéo part silencieuse+musique).
    let narrationLocalPathForQc: string | undefined;
    try {
      const script = await buildNarrationScript(videoAd.brief, niche, totalDurationSeconds);
      videoAd.narrationScript = script;

      const voiceId = pickVoiceId();
      videoAd.voiceId = voiceId;
      await videoAd.save();

      const tts = await synthesizeSpeech(script, { voiceId });
      const narrationLocalPath = path.join(os.tmpdir(), `${videoAdId}_narration.mp3`);
      tmpFiles.push(narrationLocalPath);
      await fs.writeFile(narrationLocalPath, tts.audioBuffer);

      const withVoicePath = path.join(os.tmpdir(), `${videoAdId}_with_voice.mp4`);
      tmpFiles.push(withVoicePath);
      await runFfmpegAddNarration({
        silentVideoPath: concatPath,
        narrationAudioPath: narrationLocalPath,
        totalDurationSeconds,
        outputPath: withVoicePath,
      });
      videoWithVoicePath = withVoicePath;
      narrationLocalPathForQc = narrationLocalPath;
    } catch (err) {
      // On ne casse jamais une vidéo fonctionnelle pour un problème de voix
      // off : on livre le montage silencieux + musique plutôt que d'échouer
      // toute la génération (le client a déjà payé le débit crédits).
      console.warn(`[video-pipeline] Narration TTS indisponible, livraison sans voix off`, err);
    }

    // Musique de fond légère par-dessus (narration ou silence selon ce qui précède).
    let finalPath = videoWithVoicePath;
    const track = resolveMusicTrack(niche);
    if (track?.url) {
      try {
        const musicLocalPath = await downloadToTmp(track.url, `${videoAdId}_music.mp3`);
        tmpFiles.push(musicLocalPath);
        const withMusicPath = path.join(os.tmpdir(), `${videoAdId}_with_music.mp4`);
        tmpFiles.push(withMusicPath);
        await runFfmpegMixBackgroundMusicUnderVoice({
          videoWithVoicePath,
          musicPath: musicLocalPath,
          outputPath: withMusicPath,
        });
        finalPath = withMusicPath;

        // Contrôle qualité voix/musique : vérifie sur les fichiers réellement
        // utilisés (et non sur la seule hypothèse MUSIC_VOLUME_PRO) que la
        // voix reste nettement au-dessus de la musique une fois mixée. Si
        // l'écart est insuffisant, on relance UNE fois le mix avec une
        // atténuation renforcée de la musique avant de livrer — jamais
        // d'échec de toute la génération pour ce seul critère.
        if (narrationLocalPathForQc) {
          try {
            const balance = await checkVoiceOverMusicBalance({
              narrationPath: narrationLocalPathForQc,
              musicPath: musicLocalPath,
              musicVolumeFactor: env.MUSIC_VOLUME_PRO,
            });
            if (!balance.ok) {
              console.warn(
                `[video-pipeline] QC voix/musique insuffisant (écart ${balance.gapDb.toFixed(1)}dB < ${MIN_VOICE_OVER_MUSIC_DB}dB), remix avec musique atténuée`
              );
              const retryVolume = Math.max(env.MUSIC_VOLUME_PRO / 2, 0.03);
              const withMusicRetryPath = path.join(os.tmpdir(), `${videoAdId}_with_music_retry.mp4`);
              tmpFiles.push(withMusicRetryPath);
              await runFfmpegMixBackgroundMusicUnderVoice({
                videoWithVoicePath,
                musicPath: musicLocalPath,
                outputPath: withMusicRetryPath,
                musicVolumeOverride: retryVolume,
              });
              finalPath = withMusicRetryPath;
            }
          } catch (qcErr) {
            // Le diagnostic voix/musique lui-même est best-effort : s'il échoue
            // (fichier non mesurable), on livre le mix déjà obtenu sans bloquer.
            console.warn(`[video-pipeline] QC voix/musique non mesurable, mix initial conservé`, qcErr);
          }
        }
      } catch (err) {
        console.warn(`[video-pipeline] Musique de fond indisponible (${track.id}), livraison sans musique`, err);
      }
    } else {
      console.warn(`[video-pipeline] Aucun track musical configuré pour la niche "${niche}" — MUSIC_TRACK_*_URL manquant`);
    }

    // CTA + watermark marque incrustés en dernière étape (code déjà prévu,
    // jamais branché jusqu'ici — voir décision produit).
    try {
      const brief = videoAd.brief as { brandName?: string; ctaText?: string; siteMeta?: { title?: string }; offerHighlights?: string[] };
      const brandName = brief.brandName || brief.siteMeta?.title;
      const withCtaPath = path.join(os.tmpdir(), `${videoAdId}_with_cta.mp4`);
      tmpFiles.push(withCtaPath);
      await runFfmpegAddCtaOverlay({
        inputPath: finalPath,
        outputPath: withCtaPath,
        totalDurationSeconds,
        brandName,
        ctaText: brief.ctaText,
        offerHighlights: brief.offerHighlights,
      });
      finalPath = withCtaPath;
    } catch (err) {
      // Jamais bloquant : la vidéo part sans CTA incrusté plutôt que d'échouer.
      console.warn(`[video-pipeline] Overlay CTA indisponible, livraison sans CTA incrusté`, err);
    }

    return finalPath;
}

/**
 * Option 2 — "Avatar" (avatar_standard : 30s/60s, avatar_scenario : 120s).
 * Portrait généré par Grok Imagine + narration TTS + lipsync FalAI Kling
 * Avatar. Le Mode Scénario chaîne 2 segments Pro de 60s max (contrainte
 * fournisseur, voir falai-avatar.service.ts) et les concatène.
 */
async function runAvatarPipeline(
  videoAd: HydratedDocument<any>,
  videoAdId: string,
  niche: string,
  tmpFiles: string[]
): Promise<string> {
  const isScenario = videoAd.mode === 'avatar_scenario';
  const quality: AvatarQuality = isScenario ? 'pro' : 'standard';
  const totalDurationSeconds = videoAd.format === '30s' ? 30 : 60; // avatar_scenario est toujours 120s

  // 1. Script + portrait du présentateur (Claude + Grok Imagine)
  const script = await buildNarrationScript(
    videoAd.brief,
    niche,
    isScenario ? 120 : totalDurationSeconds
  );
  videoAd.narrationScript = script;
  await videoAd.save();

  const brief = videoAd.brief as any;
  const brand = String(brief?.brandName || brief?.siteMeta?.title || '');
  const portraitPrompt = `Photorealistic professional presenter, upper body visible, facing camera, neutral studio background, natural lighting, warm and trustworthy expression. Brand context: ${brand}. No text, no watermark.`;
  const portrait = await generateGrokImagine({ prompt: portraitPrompt, aspectRatio: videoAd.aspectRatio });
  videoAd.characterImageUrl = portrait.url;
  await videoAd.save();

  // 2. Narration TTS complète (une seule synthèse — assure la continuité de
  // voix entre les segments chaînés du Mode Scénario)
  const tts = await synthesizeSpeech(script);
  const fullNarrationPath = path.join(os.tmpdir(), `${videoAdId}_narration_full.mp3`);
  tmpFiles.push(fullNarrationPath);
  await fs.writeFile(fullNarrationPath, tts.audioBuffer);
  videoAd.narrationAudioUrl = (await uploadNarrationAudio(tts.audioBuffer, `${videoAdId}_narration`)).url;
  await videoAd.save();

  // 3. Génération avatar : 1 seul appel FalAI si ≤60s (Standard), 2 appels
  // chaînés de 60s max si Mode Scénario (contrainte FALAI_AVATAR_MAX_SECONDS_PER_CALL).
  const segmentDurations = isScenario
    ? [FALAI_AVATAR_MAX_SECONDS_PER_CALL, totalDurationSeconds - FALAI_AVATAR_MAX_SECONDS_PER_CALL || FALAI_AVATAR_MAX_SECONDS_PER_CALL]
    : [totalDurationSeconds];
  // Pour avatar_scenario (120s) : 2 segments de 60s exactement.
  const segments = isScenario ? [60, 60] : segmentDurations;

  const clipLocalPaths: string[] = [];
  let cursorSeconds = 0;

  for (let i = 0; i < segments.length; i++) {
    const segDuration = segments[i];
    const segmentAudioPath = path.join(os.tmpdir(), `${videoAdId}_segaudio_${i}.mp3`);
    tmpFiles.push(segmentAudioPath);

    // Découpe l'audio complet en segments de segDuration secondes (continuité
    // narrative garantie car c'est UNE narration synthétisée une seule fois).
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-i', fullNarrationPath,
        '-ss', String(cursorSeconds), '-t', String(segDuration),
        '-c', 'copy', segmentAudioPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new AppError(`ffmpeg découpe audio échouée: ${stderr.slice(-300)}`, 500))));
      proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable: ${err.message}`, 500)));
    });
    cursorSeconds += segDuration;

    const segmentAudioUrl = (await uploadNarrationAudio(await fs.readFile(segmentAudioPath), `${videoAdId}_seg${i}`)).url;

    let lastError: string | undefined;
    let succeeded = false;
    // 1 tentative + 1 retry automatique, même politique que l'Option 1.
    for (let attempt = 0; attempt < 2 && !succeeded; attempt++) {
      try {
        const clip = await generateAvatarClip({
          imageUrl: portrait.url,
          audioUrl: segmentAudioUrl,
          quality,
        });
        const localPath = await downloadToTmp(clip.outputUrl, `${videoAdId}_avatar_seg${i}.mp4`);
        tmpFiles.push(localPath);
        clipLocalPaths.push(localPath);
        succeeded = true;
      } catch (err) {
        lastError = (err as Error).message;
        console.warn(`[video-pipeline] Segment avatar ${i} tentative ${attempt + 1} échouée`, err);
      }
    }
    if (!succeeded) {
      throw new AppError(`Segment avatar ${i} échoué après retry : ${lastError}`, 502);
    }
  }

  // 4. Concaténation si Mode Scénario (2 segments), sinon le seul clip suffit.
  let finalPath = clipLocalPaths[0];
  if (clipLocalPaths.length > 1) {
    const concatPath = path.join(os.tmpdir(), `${videoAdId}_avatar_concat.mp4`);
    tmpFiles.push(concatPath);
    await runFfmpegConcat(clipLocalPaths, concatPath);
    finalPath = concatPath;
  }

  // 5. CTA + watermark marque + offres détectées incrustés en dernière
  // étape — même fonction que l'Option 1 (voix_off), jamais branchée ici
  // avant (gap pré-existant : l'Avatar sortait sans aucun overlay).
  // Best-effort : jamais bloquant, la vidéo part sans overlay plutôt que
  // d'échouer une génération déjà coûteuse (portrait + lipsync FalAI payés).
  try {
    const overlayDuration = isScenario ? 120 : totalDurationSeconds;
    const briefForOverlay = videoAd.brief as { brandName?: string; ctaText?: string; siteMeta?: { title?: string }; offerHighlights?: string[] };
    const withCtaPath = path.join(os.tmpdir(), `${videoAdId}_avatar_with_cta.mp4`);
    tmpFiles.push(withCtaPath);
    await runFfmpegAddCtaOverlay({
      inputPath: finalPath,
      outputPath: withCtaPath,
      totalDurationSeconds: overlayDuration,
      brandName: briefForOverlay.brandName || briefForOverlay.siteMeta?.title,
      ctaText: briefForOverlay.ctaText,
      offerHighlights: briefForOverlay.offerHighlights,
    });
    finalPath = withCtaPath;
  } catch (err) {
    console.warn(`[video-pipeline] Overlay CTA/offres indisponible (Avatar), livraison sans overlay`, err);
  }

  return finalPath;
}
