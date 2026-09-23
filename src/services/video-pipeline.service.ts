import { classerEchec } from '@/services/echec-classifier.service';
import { normaliserChoixAvatar, construirePromptPortrait } from '@/services/avatar-choix.service';
import { signalerIncident } from '@/services/platform-alert.service';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { HydratedDocument } from 'mongoose';
import { VideoAd } from '@/models/VideoAd';
import { Site, ISite } from '@/models/Site';
import { User } from '@/models/User';
import { callClaude } from '@/services/ai-clients';
import { consigneLangue, type Langue } from '@/constants/pays';
import { generateGrokImagine } from '@/services/grok-imagine.service';
import { generateKlingVideoClip, FalaiBusyError } from '@/services/falai-video.service';
import {
  AlexyaBusyError,
  generateAlexyaVideoClip,
  uploadVideoStartFrameFromUrl,
} from '@/services/alexya-video.service';
import {
  generateAvatarClip,
  FALAI_AVATAR_MAX_SECONDS_PER_CALL,
  type AvatarQuality,
} from '@/services/falai-avatar.service';
import { synthesizeSpeech, estimateSpeechDurationSeconds, pickVoiceId } from '@/services/tts.service';
import { uploadVideoAd, uploadNarrationAudio, deleteVideoAdClip } from '@/services/cloudinary.service';
import {
  debitCredits,
  getVideoAdCreditCost,
  getVideoEngineForFormat,
  getVideoAdRelaunchCost,
  assertVideoAdModeAllowed,
  VideoAdFormat,
  VideoAdMode,
  VideoAdQuality,
} from '@/services/credits.service';
import { AppError } from '@/middleware/errorHandler';
import { videoQueue } from '@/jobs/queue';
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
 * immédiatement, puis enqueue le job BullMQ.
 *
 * En cas d'échec total, les crédits ne sont PAS remboursés : ils restent
 * affectés à cette vidéo et le client dispose d'une relance gratuite illimitée
 * (voir enqueueVideoAdRelaunch).
 */
export async function enqueueVideoAd(
  userId: string,
  opts: {
    siteId?: string;
    mode: VideoAdMode;
    format: VideoAdFormat;
    quality: VideoAdQuality;
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
  // description libre du client. Indispensable : sans lui, un client
  // choisissant un site NexAI existant sans taper de texte n'aurait aucun
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

  const cost = getVideoAdCreditCost(opts.mode, opts.format, opts.quality);

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

  // Anti double-commande — AVANT le débit. Une vidéo coûte cher (appel
  // fournisseur réel) : un double clic facturait deux générations identiques.
  // L'unicité se joue ici sur l'utilisateur, une vidéo n'étant pas
  // nécessairement rattachée à un site.
  const videoEnCours = await VideoAd.findOne({
    userId,
    status: { $in: ['queued', 'generating'] },
    createdAt: { $gte: new Date(Date.now() - 10_000) },
  })
    .select('_id')
    .lean();
  if (videoEnCours) {
    throw new AppError(
      'Une génération vidéo vient déjà d\'être lancée. Patientez quelques instants avant d\'en demander une autre.',
      409
    );
  }

  // ── Cadeau de bienvenue ──
  //
  // La première vidéo de 20 s est offerte. La consommation est ATOMIQUE :
  // la condition et la mise à jour se font en une seule opération, si bien
  // que deux demandes simultanées ne peuvent jamais obtenir deux vidéos
  // gratuites. Seul le format 20 s est concerné.
  let videoOfferte = false;
  if (opts.format === '20s' && opts.mode !== 'mini_film') {
    const consomme = await User.findOneAndUpdate(
      { _id: userId, videoOfferteDisponible: true },
      { $set: { videoOfferteDisponible: false } },
      { new: false }
    ).select('_id');
    videoOfferte = !!consomme;
  }

  if (!videoOfferte) {
    await debitCredits(userId, cost, 'video_ad', {
      relatedSiteId: opts.siteId,
      note: `video_ad:${opts.mode}:${opts.format}`,
    });
  }

  const videoAd = await VideoAd.create({
    userId,
    siteId: opts.siteId || undefined,
    mode: opts.mode,
    format: opts.format,
    quality: opts.quality,
    aspectRatio: opts.aspectRatio,
    brief: opts.brief,
    creditsCharged: videoOfferte ? 0 : cost,
    offerte: videoOfferte,
    status: 'queued',
    scenes: [],
  });

  const bullJob = await videoQueue.add(
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

  // ── Trois chemins de relance, volontairement distincts ──
  //
  // A. RELANCE GRATUITE APRÈS PANNE : rien n'a jamais été livré alors que des
  //    crédits ont été débités. Le client n'a pas eu ce qu'il a payé, donc il
  //    relance sans rien repayer, SANS LIMITE DE NOMBRE. Aucun remboursement
  //    en crédits n'intervient — ils restent affectés à cette vidéo.
  //    Le coût pour NexAI est quasi nul : si rien n'a abouti, rien n'a été
  //    facturé par les fournisseurs. Seul un délai s'applique, pour ne pas
  //    s'acharner pendant une panne.
  //
  // B. RELANCE PARTIELLE (livraison incomplète) : la vidéo a été livrée mais
  //    des plans manquent. GRATUITE aussi, car le client n'a pas eu le format
  //    complet qu'il a payé — mais PLAFONNÉE, car chaque tentative régénère de
  //    vrais plans et coûte donc à NexAI. Sans plafond, un plan que le modèle
  //    refuse systématiquement pourrait se relancer indéfiniment.
  //    Seuls les plans MANQUANTS sont régénérés : les plans réussis sont
  //    réutilisés depuis notre stockage (voir scene.clipUrl).
  //
  // C. RELANCE CORRECTIVE (défaut mineur de qualité) : la vidéo est complète
  //    et exploitable, le client veut simplement un autre rendu. PLEIN TARIF —
  //    c'est une nouvelle génération, pas une réparation due.
  const echecTotal = original.status === 'failed' && !original.finalVideoUrl;
  const relanceGratuite = echecTotal && ((original.creditsCharged ?? 0) > 0 || original.offerte === true);

  const plansManquants = (original.partialDelivery?.scenesFailed ?? 0) > 0;
  const relancesDejaFaites = original.partialRelaunchCount ?? 0;
  const relancePartielle =
    !echecTotal && original.status === 'completed' && plansManquants;

  let cost: number;

  if (relanceGratuite) {
    // Deux tentatives immédiates, puis une pause.
    //
    // Un incident passager se règle souvent dès le deuxième essai. Au-delà,
    // c'est probablement une vraie panne : insister ne sert à rien, coûte des
    // appels fournisseurs et donne au client le sentiment d'un service
    // cassé. La pause revient donc toutes les deux tentatives ratées.
    const relancesRatees = original.echecRelanceCount ?? 0;
    const pauseRequise = relancesRatees > 0 && relancesRatees % RELANCES_AVANT_PAUSE === 0;
    const depuisEchec = Date.now() - (original.failedAt?.getTime() ?? 0);
    if (pauseRequise && depuisEchec < FREE_RELAUNCH_COOLDOWN_MS) {
      const minutes = Math.ceil((FREE_RELAUNCH_COOLDOWN_MS - depuisEchec) / 60000);
      throw new AppError(
        `Le service est momentanément indisponible. Nos dernières tentatives n'ont pas abouti, ` +
          `en raison d'un incident technique de notre côté. Nous y travaillons. ` +
          `Vous pourrez relancer gratuitement dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        429
      );
    }
    cost = 0;
  } else if (relancePartielle) {
    const plafondPartiel =
      MAX_PARTIAL_RELAUNCHES_PAR_FORMAT[original.format as VideoAdFormat] ?? 1;
    if (relancesDejaFaites >= plafondPartiel) {
      throw new AppError(
        'Votre vidéo reste disponible. Pour explorer une autre direction créative, lancez une nouvelle génération.',
        403
      );
    }
    cost = 0;
  } else {
    if (original.status !== 'completed') {
      throw new AppError("Seule une vidéo livrée peut faire l'objet d'une relance corrective.", 400);
    }
    if (!original.relaunchOffer?.eligible) {
      throw new AppError("Cette vidéo n'a pas de défaut détecté ouvrant droit à une relance corrective.", 400);
    }
    if (original.relaunchOffer.used) {
      throw new AppError('Une relance corrective a déjà été utilisée pour cette vidéo.', 400);
    }
    cost = original.relaunchOffer.priceCredits || getVideoAdRelaunchCost(original.creditsCharged, !original.isRelaunchOf);
  }

  if (cost > 0) {
    await debitCredits(userId, cost, 'video_ad_relance', {
      relatedSiteId: original.siteId,
      note: `video_ad_relance:${originalVideoAdId}`,
    });
  }

  if (relanceGratuite) {
    // Le délai repart : si cette tentative échoue aussi, le client devra à
    // nouveau patienter avant la suivante. Son droit reste entier.
    original.failedAt = new Date();
    await original.save();
  } else {
    // Marquer l'offre d'origine comme consommée avant de créer la nouvelle
    // vidéo, pour éviter qu'un double-clic ne déclenche deux relances payantes.
    original.relaunchOffer!.used = true;
    await original.save();
  }

  // ── Héritage des plans réussis (relance partielle) ──
  //
  // On recopie les plans déjà obtenus dans la nouvelle vidéo, en conservant
  // LEUR POSITION. Seuls les plans manquants seront régénérés : le reste est
  // réutilisé tel quel depuis notre stockage.
  //
  // Un plan n'est repris que s'il porte une URL sur NOTRE domaine — un plan
  // archivé chez le fournisseur (échec d'upload, voir processVideoAd) serait
  // susceptible d'avoir expiré, on préfère le régénérer que livrer un trou.
  const scenesHeritees =
    relancePartielle && Array.isArray(original.scenes)
      ? original.scenes.map((s) => {
          const reutilisable =
            s.status === 'completed' && typeof s.clipUrl === 'string' && estUrlArchivee(s.clipUrl);
          return {
            index: s.index,
            prompt: s.prompt,
            durationSeconds: s.durationSeconds,
            // Plan conservé : le pipeline le réutilisera sans le régénérer.
            // Plan à refaire : remis à zéro pour repartir proprement.
            status: reutilisable ? 'completed' : 'pending',
            clipUrl: reutilisable ? s.clipUrl : undefined,
            source: reutilisable ? s.source : undefined,
            engine: reutilisable ? s.engine : undefined,
            // L'image de départ n'est JAMAIS reprise pour un plan à refaire :
            // c'est peut-être elle qui a fait échouer le modèle. On en
            // régénère une nouvelle (0,04 $) pour maximiser les chances.
            referenceImageUrl: reutilisable ? s.referenceImageUrl : undefined,
            referenceImageKind: reutilisable ? s.referenceImageKind : undefined,
          };
        })
      : [];

  const videoAd = await VideoAd.create({
    userId,
    siteId: original.siteId,
    mode: original.mode,
    format: original.format,
    quality: original.quality,
    aspectRatio: original.aspectRatio,
    brief: original.brief,
    creditsCharged: cost,
    // Le DROIT à la relance gratuite suit la chaîne.
    //
    // Sans cela : un client paie, sa vidéo échoue, il relance gratuitement
    // (creditsCharged = 0), cette relance échoue aussi — et le système lui
    // refusait toute nouvelle tentative, puisqu'il ne voyait plus de
    // paiement. Il avait payé et n'obtenait rien.
    offerte: original.offerte === true || relanceGratuite,
    echecRelanceCount: relanceGratuite ? (original.echecRelanceCount ?? 0) + 1 : 0,
    status: 'queued',
    scenes: scenesHeritees,
    isRelaunchOf: original._id,
    // Le compteur suit la CHAÎNE de relances, pas la vidéo isolée : sinon
    // chaque nouvelle vidéo repartirait à zéro et le plafond ne servirait à
    // rien.
    partialRelaunchCount: relancePartielle ? relancesDejaFaites + 1 : 0,
  });

  const bullJob = await videoQueue.add(
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
 * - 1 retry auto par scène en cas d'échec. Si ça échoue encore → aucune vidéo
 *   livrée, crédits conservés sur la vidéo et relance gratuite ouverte au
 *   client (voir enqueueVideoAdRelaunch).
 * - Une fois le montage silencieux prêt : narration TTS (ElevenLabs, script
 *   généré par Claude) muxée sur la vidéo, puis musique de fond légère
 *   ajoutée par-dessus à bas volume (MUSIC_VOLUME_PRO) pour ne jamais couvrir
 *   la voix. Un seul flux audio pour tout le mode voix off.
 *
 * Flux Avatar (mode = 'avatar_pub' | 'mini_film') : voir
 * processAvatarVideoAd plus bas — portrait Grok Imagine + narration TTS +
 * lipsync FalAI Kling Avatar, pas de montage multi-scènes Alexya.
 */

const CLIPS_PER_FORMAT: Record<VideoAdFormat, number> = {
  '20s': 2,
  '30s': 3,
  '60s': 6,
  '120s': 12,
};
const CLIP_DURATION_SECONDS = 10;

export type CompositionMiniFilm = 'histoire' | 'decouverte' | 'presentateur';

/**
 * Compositions proposées pour le mini-film, avec leur explication destinée
 * au client. Le frontend les affiche telles quelles : personne ne doit avoir
 * à deviner ce que chaque choix produit.
 */
export const COMPOSITIONS_MINI_FILM = [
  {
    valeur: 'histoire',
    label: 'Film avec acteurs',
    description:
      'Une vraie histoire filmée : des personnages, des décors, de l’action, des mouvements de caméra. Une voix off porte le message. C’est le format des publicités télévisées, et celui que publient les créateurs de contenu.',
  },
  {
    valeur: 'decouverte',
    label: 'Film sans acteur',
    description:
      'Des scènes cinématiques qui mettent votre produit et votre site en scène — lumière travaillée, mouvements de caméra, ambiance — sans aucun personnage. L’élégance du cinéma, centrée sur ce que vous vendez.',
  },
  {
    valeur: 'presentateur',
    label: 'Présentateur face caméra',
    description:
      'Un présentateur s’adresse directement à vos clients et leur parle de votre offre, en studio. Idéal pour expliquer un service, rassurer, ou incarner votre marque.',
  },
] as const;

/** Composition valide, avec repli sur « avec présentateur ». */
export function normaliserComposition(brut: unknown): CompositionMiniFilm {
  return COMPOSITIONS_MINI_FILM.some((c) => c.valeur === brut)
    ? (brut as CompositionMiniFilm)
    : 'histoire';
}

/**
 * ── Séquence de clôture (plan de marque) ──
 *
 * Quand des plans n'ont pas pu être générés, la vidéo serait livrée plus
 * courte que le format commandé. On complète alors par une séquence de
 * présentation de la marque, construite localement avec ffmpeg à partir
 * d'images déjà en main (produit, capture du site, logo).
 *
 * Deux raisons d'en faire un plan local plutôt qu'une génération IA :
 *  - coût nul et durée nulle, donc aucune attente supplémentaire ;
 *  - déterministe, donc elle ne peut pas échouer comme une génération.
 *
 * C'est une convention publicitaire classique (carte de fin logo + produit),
 * pas un pansement visible — à condition de rester courte, d'où les deux
 * plafonds ci-dessous.
 */

/**
 * Durée maximale ABSOLUE de la séquence de clôture.
 *
 * Dans la publicité, une carte de fin dure 3 à 8 secondes ; au-delà de 10 à 15
 * l'œil décroche. Un plafond en pourcentage seul ne suffirait pas : sur un
 * format 120s, 50% donneraient une minute d'image fixe, ce qui ne serait plus
 * une clôture mais du remplissage.
 */
const CLOSING_CARD_MAX_SECONDS = 15;

/**
 * La séquence ne comble jamais plus de la moitié de la durée commandée : une
 * pub majoritairement statique dessert la marque plus qu'elle ne la sert.
 */
const CLOSING_CARD_MAX_RATIO = 0.5;

/**
 * Contenu ANIMÉ minimal pour livrer, en proportion de la durée commandée.
 *
 * Calculé sur les plans animés SEULS, sans la séquence de clôture : sinon
 * celle-ci servirait à masquer un manque, exactement ce qu'on veut éviter.
 * En dessous, on ne livre pas — le client conserve ses crédits et relance
 * gratuitement.
 */
const MIN_ANIMATED_RATIO_TO_DELIVER = 0.5;

/**
 * Exception à la règle des 50 % : le format 20 s, point d'entrée de la gamme.
 *
 * Un seul plan réussi (10 s sur 20) complété par la séquence de clôture donne
 * une vidéo courte mais pleinement exploitable, jugée préférable à un
 * non-livré. La règle des 50 % reste la règle générale et s'applique
 * intégralement aux autres formats.
 */
const FORMATS_AVEC_EXCEPTION_SEUIL: ReadonlySet<VideoAdFormat> = new Set(['20s']);

/** true si la vidéo atteint le minimum requis pour être livrée. */
function peutEtreLivree(format: VideoAdFormat, secondesAnimees: number): boolean {
  if (secondesAnimees <= 0) return false;
  if (FORMATS_AVEC_EXCEPTION_SEUIL.has(format)) return true;
  return secondesAnimees >= dureeCibleSecondes(format) * MIN_ANIMATED_RATIO_TO_DELIVER;
}

/** Durée commandée, en secondes, pour un format donné. */
function dureeCibleSecondes(format: VideoAdFormat): number {
  return CLIPS_PER_FORMAT[format] * CLIP_DURATION_SECONDS;
}

/**
 * Durée de la séquence de clôture à insérer, 0 si inutile.
 * Respecte les deux plafonds.
 */
function dureeSequenceCloture(format: VideoAdFormat, secondesAnimees: number): number {
  const cible = dureeCibleSecondes(format);
  const manque = cible - secondesAnimees;
  if (manque <= 0) return 0;
  return Math.min(manque, CLOSING_CARD_MAX_SECONDS, Math.floor(cible * CLOSING_CARD_MAX_RATIO));
}

/**
 * Langues dont le texte ne peut PAS être incrusté par ffmpeg.
 *
 * `drawtext` ne gère ni l'écriture de droite à gauche ni les ligatures
 * arabes : le texte sortirait avec les lettres détachées et dans le mauvais
 * ordre, donc illisible — pire que pas de texte du tout. Pour ces langues, la
 * séquence reste purement visuelle (logo + produit), la narration portant
 * déjà le message.
 */
const LANGUES_SANS_INCRUSTATION = new Set(['ar']);

function texteIncrustable(langue?: string): boolean {
  return !LANGUES_SANS_INCRUSTATION.has(String(langue || 'fr'));
}

/**
 * Délai d'attente avant qu'une relance GRATUITE (après panne) soit autorisée.
 *
 * Pourquoi : quand le fournisseur vidéo est indisponible, relancer dans la
 * minute échoue pour la même raison. Le délai laisse le temps au service de se
 * rétablir au lieu d'enchaîner des tentatives vouées à l'échec.
 *
 * Le droit à la relance n'est jamais perdu, il est seulement différé.
 */
export const FREE_RELAUNCH_COOLDOWN_MS = 15 * 60 * 1000;

/** Tentatives immédiates autorisées avant d'imposer une pause. */
export const RELANCES_AVANT_PAUSE = 2;

/**
 * Nombre d'attentes tolérées quand le fournisseur vidéo est saturé.
 *
 * Ces attentes ne consomment PAS les tentatives de génération : la saturation
 * signifie que la génération n'a pas pu démarrer, pas qu'elle a échoué. Les
 * confondre déclencherait à tort une panne et une relance gratuite.
 */
const MAX_BUSY_WAITS = 4;

/** Pause entre deux tentatives quand le fournisseur est saturé. */
const BUSY_RETRY_DELAY_MS = 30 * 1000;

/**
 * Relances gratuites autorisées quand la vidéo a été LIVRÉE mais incomplète.
 *
 * Plafonné, contrairement à la relance après panne totale : ici chaque
 * tentative régénère de vrais plans et coûte donc à NexAI. Sans plafond, un
 * plan que le modèle refuse systématiquement se relancerait indéfiniment.
 *
 * Le plafond dépend du FORMAT, parce que la marge en dépend. Sur un 20 s
 * vendu comme point d'entrée, deux relances suffisent à effacer le bénéfice
 * et une troisième le ferait passer en perte. Les formats longs, mieux
 * margés et dont chaque plan manquant coûte moins cher à régénérer, en
 * supportent trois sans difficulté.
 */
const MAX_PARTIAL_RELAUNCHES_PAR_FORMAT: Record<VideoAdFormat, number> = {
  '20s': 1,
  '30s': 1,
  '60s': 3,
  '120s': 3,
};

/**
 * true si l'URL du clip pointe sur NOTRE stockage (Cloudinary) et non sur
 * celui d'un fournisseur.
 *
 * Les URL fal.media et alexya.ai ne sont pas garanties dans la durée : un plan
 * qui n'a pas pu être archivé chez nous ne doit pas être réutilisé lors d'une
 * relance, sous peine de produire une vidéo avec un plan manquant.
 */
function estUrlArchivee(url: string): boolean {
  return /res\.cloudinary\.com/i.test(url);
}

/**
 * Archive sur notre stockage les plans réussis d'une vidéo INCOMPLÈTE.
 *
 * Appelé uniquement quand des plans manquent : une vidéo complète n'a aucune
 * raison de conserver ses plans séparés, et les archiver toutes saturerait le
 * stockage pour rien (environ 35 Mo de rushes par pub de 30 s).
 *
 * En cas d'échec d'archivage sur un plan, on laisse simplement son URL
 * fournisseur : la relance régénérera ce plan plutôt que de risquer une URL
 * expirée (voir estUrlArchivee).
 */
async function archiverPlansPourRelance(
  videoAd: HydratedDocument<any>,
  videoAdId: string,
  clipByIndex: (string | undefined)[]
): Promise<void> {
  for (let i = 0; i < videoAd.scenes.length; i++) {
    const scene = videoAd.scenes[i];
    const localPath = clipByIndex[i];
    if (scene.status !== 'completed' || !localPath) continue;
    // Déjà archivé (plan hérité d'une relance précédente) : rien à refaire.
    if (typeof scene.clipUrl === 'string' && estUrlArchivee(scene.clipUrl)) continue;
    try {
      const buffer = await fs.readFile(localPath);
      const uploaded = await uploadVideoAd(buffer, `${videoAdId}_scene${i}`);
      scene.clipUrl = uploaded.url;
      scene.clipPublicId = uploaded.publicId;
    } catch (err) {
      console.warn(
        `[video-pipeline] Archivage du plan ${i} impossible — il sera régénéré en cas de relance`,
        err
      );
    }
  }
}

/**
 * Supprime les plans archivés d'une vidéo : ils ne peuvent plus servir.
 *
 * Déclenché quand une relance a complété la vidéo, ou quand le plafond de
 * relances est atteint. La vidéo finale livrée n'est JAMAIS concernée : elle
 * reste téléchargeable indéfiniment par le client.
 */
async function supprimerPlansArchives(videoAd: HydratedDocument<any>): Promise<void> {
  if (!Array.isArray(videoAd.scenes)) return;
  for (const scene of videoAd.scenes) {
    if (!scene.clipPublicId) continue;
    await deleteVideoAdClip(scene.clipPublicId);
    scene.clipPublicId = undefined;
  }
}

/**
 * Nombre de plans générés SIMULTANÉMENT, par moteur.
 *
 * Les deux fournisseurs n'ont pas la même limite de concurrence, et la
 * dépasser ne produit que des refus : la valeur doit rester alignée sur ce que
 * le fournisseur autorise réellement.
 *
 *  · Kling / fal.ai (Premium) — limite par défaut : 1 génération simultanée
 *    par compte. On reste donc à 1 : c'est le comportement séquentiel actuel,
 *    sans aucune régression. Dès que fal relève la limite (demande gratuite
 *    auprès de leur support), passer WORKER_VIDEO_SCENE_CONCURRENCY_PREMIUM
 *    à 3 depuis Render divise le temps de livraison par ~3, sans redéploiement.
 *
 *  · Alexya (Standard) — limite documentée : 5 générations concurrentes par
 *    compte, relevable sur demande. On utilise 3, ce qui laisse de la marge
 *    pour plusieurs vidéos traitées en même temps par le worker sans jamais
 *    atteindre le plafond du compte.
 *
 * Un dépassement n'est de toute façon jamais fatal : les refus de concurrence
 * sont traités comme une saturation (attente + reprise), pas comme un échec.
 */
function getSceneConcurrency(format: VideoAdFormat): number {
  const moteur = getVideoEngineForFormat(format);
  const raw =
    moteur === 'kling'
      ? process.env.WORKER_VIDEO_SCENE_CONCURRENCY_PREMIUM
      : process.env.WORKER_VIDEO_SCENE_CONCURRENCY_STANDARD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  // Aucun plafond : la valeur posée dans Render s'applique telle quelle.
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return moteur === 'kling' ? 1 : 3;
}

/**
 * Exécute `task(i)` pour i de 0 à count-1, avec au plus `limit` tâches en vol.
 *
 * Les tâches ne rejettent jamais (processScene capture ses propres erreurs) :
 * un plan raté n'interrompt donc pas les autres. On protège tout de même
 * contre une exception inattendue pour qu'elle n'annule pas la série.
 */
async function runWithConcurrency(
  count: number,
  limit: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      try {
        await task(i);
      } catch (err) {
        console.error(`[video-pipeline] Erreur inattendue sur le plan ${i}`, err);
      }
    }
  });
  await Promise.all(workers);
}

function buildDossierContext(brief: Record<string, unknown>): string {
  const dossierText = typeof (brief as any).siteContentDossier === 'string' ? (brief as any).siteContentDossier : '';
  if (!dossierText) return '';
  return `\nDossier de contenu complet du site (toutes les pages analysées) :
${dossierText}

Instruction impérative de couverture : identifie TOUTES les offres/services distincts présents dans ce dossier. La vidéo doit les couvrir ou au minimum les évoquer tous ensemble (ex: "que ce soit pour X, Y ou Z") — ne te concentre jamais sur une seule offre alors que le site en propose plusieurs, et n'invente jamais une offre absente du dossier.`;
}

function buildScenesPrompt(
  brief: Record<string, unknown>,
  niche: string,
  nbScenes: number,
  /** Mode de la vidéo — décide du STYLE des plans. */
  mode: VideoAdMode = 'voix_off',
  /** Composition, uniquement pour le mini-film. */
  composition?: CompositionMiniFilm | null
): string {
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

  // Histoire fournie par le client, si elle existe. Beaucoup de clients ne
  // savent pas inventer un scénario — dans ce cas le scénariste en écrit un
  // lui-même, adapté au produit, à la marque et au public visé. Personne ne
  // doit être privé d'une bonne publicité faute de savoir la raconter.
  const histoire = String((brief as Record<string, unknown>).scenario ?? '').trim();
  const consigneHistoire = histoire
    ? `\nHISTOIRE VOULUE PAR LE CLIENT — c'est le fil à suivre :\n${histoire.slice(0, 1500)}\n` +
      `Respecte cette histoire. Tu peux l'enrichir visuellement, jamais la remplacer.`
    : `\nLe client n'a pas décrit d'histoire. INVENTE-EN UNE, professionnelle et crédible, ` +
      `qui met en valeur son produit ou son service auprès de son public. Une vraie petite ` +
      `histoire avec une situation de départ, une découverte du produit, et une résolution — ` +
      `pas un catalogue de plans décoratifs.`;

  // ── Style des plans, selon le mode ──
  //
  // Le cinéma et les acteurs sont EXCLUSIFS au mini-film. C'est ce qui le
  // distingue des formats courts et justifie son prix. Un format court qui
  // produirait des scènes cinématiques avec acteurs enlèverait toute raison
  // de payer le mini-film.
  const estMiniFilm = mode === 'mini_film';
  const avecActeurs = estMiniFilm && composition === 'histoire';

  const consigneStyle = !estMiniFilm
    ? `\nSTYLE — PRÉSENTATION DU SITE ET DES PRODUITS :
- AUCUN personnage, AUCUN acteur, AUCUN visage humain à l'écran. C'est une règle absolue.
- Montre le SITE du client : ses pages parcourues, ses sections, ses rubriques, sa mise en page.
- Montre les PRODUITS ou les SERVICES : en gros plan, sous plusieurs angles, en situation d'usage — mais sans personne pour les manipuler.
- Présente chaque option, chaque service, chaque avantage l'un après l'autre : le spectateur doit comprendre ce que propose ce site.
- Des mains peuvent apparaître pour manipuler un produit, jamais un visage ni une silhouette complète.`
    : avecActeurs
      ? `\nSTYLE — FILM PUBLICITAIRE AVEC ACTEURS :
- C'est du CINÉMA : des personnages vivent une scène, dans de vrais décors, avec des mouvements de caméra travaillés.
- Les personnages agissent : ils marchent, courent, découvrent le produit, réagissent, se croisent.
- La parole est portée par une VOIX OFF, jamais par les lèvres des personnages. Évite donc les gros plans sur un visage qui parle : préfère l'action, la réaction, la manipulation du produit.
- Si un personnage revient d'un plan à l'autre, DÉCRIS-LE EXACTEMENT DE LA MÊME FAÇON (âge, carnation, coiffure, vêtements) pour qu'on le reconnaisse.
- Les derniers plans montrent le site du client et invitent à s'y rendre.`
      : `\nSTYLE — FILM CINÉMATIQUE SANS ACTEUR :
- C'est du CINÉMA, mais SANS aucun personnage : lumière travaillée, mouvements de caméra lents, profondeur de champ, ambiance soignée.
- Le produit est le héros : on le découvre progressivement, sous des angles choisis, dans des décors qui racontent son univers.
- Le site du client apparaît comme une étape de cette découverte, mis en scène avec le même soin.
- AUCUN visage, AUCune silhouette. Des mains peuvent manipuler le produit.`;

  return `Tu es le scénariste vidéo NexAI. Découpe une publicité de ${nbScenes} plans de 10 secondes chacun pour un site ${niche || 'général'}.
Brief client (JSON) : ${JSON.stringify({ ...brief, siteMeta: undefined, siteContentDossier: undefined })}
${siteContext}
${dossierContext}
${consigneHistoire}
${consigneStyle}

Réponds en JSON strict uniquement, un tableau de ${nbScenes} objets :
[{"description": "description visuelle précise du plan (mouvement de caméra, sujet, ambiance, PAS de texte à l'écran)"}]

RÈGLES COMMUNES :
- Les plans doivent raconter une progression (accroche → développement → résolution → appel à l'action), pas ${nbScenes} plans déconnectés.
- Si un site réel a été analysé, les plans doivent refléter fidèlement son identité et son message.`;
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
/** Langue d'interface du propriétaire d'une vidéo (défaut : français). */
async function langueDuProprietaire(userId: unknown): Promise<Langue> {
  try {
    const u = await User.findById(userId as string).select('langue').lean();
    return ((u as { langue?: Langue } | null)?.langue as Langue) ?? 'fr';
  } catch {
    return 'fr';
  }
}

async function buildNarrationScript(
  brief: Record<string, unknown>,
  niche: string,
  targetDurationSeconds: number,
  /** Langue du client : la voix off doit parler la langue de SON marché. */
  langue: Langue = 'fr'
): Promise<string> {
  const siteMeta = (brief as any).siteMeta;
  const maxWords = Math.max(15, Math.round((targetDurationSeconds / 60) * 150));
  const siteContext = siteMeta
    ? `\nContexte du site réel : titre="${siteMeta.title || ''}", description="${(siteMeta.description || '').slice(0, 300)}"`
    : '';
  const dossierContext = buildDossierContext(brief);

  const system = `Tu es rédacteur publicitaire NexAI. Tu écris un script de voix off percutant, prêt à être lu par une voix de synthèse.
Règles strictes :
- Maximum ${maxWords} mots (durée cible : ${targetDurationSeconds} secondes de lecture naturelle)
- Structure : accroche immédiate → bénéfice/promesse → appel à l'action clair à la fin
- Phrases courtes, rythme dynamique, pas de jargon
- Le texte lu porte l'essentiel de la couverture des offres (la vidéo ne peut montrer que quelques plans) : si plusieurs offres distinctes existent, regroupe-les intelligemment plutôt que de n'en citer qu'une seule par défaut
- Réponds UNIQUEMENT avec le texte du script, sans titre, guillemets ni explication

${consigneLangue(langue)}`;

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
 * Enchaînement en fondu (xfade) entre TOUS les plans, logo d'intro compris :
 * un seul montage cohérent plutôt qu'un logo à part et un concat séparé pour
 * le reste.
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
  /** Langue du client — conditionne l'incrustation de texte. */
  langue?: string;
}): Promise<void> {
  const { silentVideoPath, musicPath, totalDurationSeconds, outputPath } = params;
  // Incrustation désactivée pour les écritures que `drawtext` ne sait pas
  // rendre (arabe : lettres détachées et ordre inversé). Un texte illisible
  // incrusté dans la vidéo livrée serait pire que pas de texte du tout ; la
  // narration porte déjà le message.
  const avecTexte = texteIncrustable(params.langue);
  const brand = avecTexte && params.brandName ? escapeDrawtext(params.brandName.slice(0, 40)) : '';
  const cta = avecTexte ? escapeDrawtext((params.ctaText || 'Découvrez-en plus').slice(0, 60)) : '';
  const offersLine = avecTexte ? escapeDrawtext(buildOffersOverlayLine(params.offerHighlights)) : '';
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

  if (cta) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${cta}':fontcolor=white:fontsize=36:` +
        `x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.45:boxborderw=14:enable='gte(t,${ctaStart})'[vout]`
    );
    videoLabel = 'vout';
  }

  // Aucune incrustation possible (langue non supportée par drawtext) : la
  // piste vidéo passe telle quelle. Le label brut '0:v' se mappe SANS
  // crochets, contrairement à un label de filtre.
  const aucunFiltreVideo = videoLabel === '0:v';
  const mapArgs: string[] = ['-map', aucunFiltreVideo ? '0:v' : `[${videoLabel}]`];

  if (musicPath) {
    filters.push(`[1:a]volume=${env.MUSIC_VOLUME}[aout]`);
    mapArgs.push('-map', '[aout]');
  }

  // Un -filter_complex vide fait échouer ffmpeg : on ne l'ajoute que s'il y a
  // réellement au moins un filtre.
  if (filters.length > 0) {
    args.push('-filter_complex', filters.join(';'));
  }
  args.push(...mapArgs);
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
 * Tier "avec_son" : le clip arrive déjà avec une narration/ambiance sonore.
 *
 * NOTE : aucun moteur actuel ne produit ce cas — Standard (Alexya "best") et
 * Premium (Kling V3 Pro) génèrent tous deux des clips SILENCIEUX, la voix
 * venant systématiquement d'ElevenLabs. Conservé pour un éventuel moteur
 * audio-natif futur.
 * On ajoute UNIQUEMENT une musique de fond à
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
 * runFfmpegMixBackgroundMusicUnderVoice.
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
 * runFfmpegCrossfadeConcat), ce qui évite d'avoir à sonder la résolution
 * native d'un fournisseur pour que tout s'assemble proprement.
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
/**
 * Construit la séquence de clôture : image fixe animée d'un lent zoom
 * (effet Ken Burns), avec éventuellement la marque et l'appel à l'action.
 *
 * Le zoom est essentiel : une image parfaitement immobile après des plans en
 * mouvement se lit comme un blocage. Un léger mouvement suffit à l'intégrer
 * naturellement au reste de la vidéo.
 *
 * Le texte est omis pour les langues que `drawtext` ne sait pas rendre (voir
 * LANGUES_SANS_INCRUSTATION) : dans ce cas la séquence reste visuelle.
 */
async function runFfmpegBuildClosingCardClip(params: {
  imagePath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  brandName?: string;
  ctaText?: string;
  langue?: string;
}): Promise<void> {
  const { imagePath, outputPath, width, height, fps, durationSeconds } = params;
  const frames = Math.max(1, Math.round(durationSeconds * fps));

  // Zoom progressif de 1.0 à ~1.08 sur toute la durée.
  const filtres = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='min(zoom+0.0006,1.08)':d=${frames}:s=${width}x${height}:fps=${fps}`,
    'format=yuv420p',
    'fade=t=in:st=0:d=0.4',
  ];

  if (texteIncrustable(params.langue)) {
    const fontPath = env.FFMPEG_FONT_PATH;
    const brand = escapeDrawtext((params.brandName || '').slice(0, 40));
    const cta = escapeDrawtext((params.ctaText || 'Découvrez-en plus').slice(0, 60));
    // Voile sombre pour garantir la lisibilité quelle que soit l'image.
    filtres.push(`drawbox=x=0:y=0:w=${width}:h=${height}:color=black@0.35:t=fill`);
    if (brand) {
      filtres.push(
        `drawtext=fontfile='${fontPath}':text='${brand}':fontcolor=white:fontsize=${Math.round(height / 18)}:` +
          `x=(w-text_w)/2:y=(h/2)-(text_h):shadowcolor=black@0.6:shadowx=2:shadowy=2`
      );
    }
    filtres.push(
      `drawtext=fontfile='${fontPath}':text='${cta}':fontcolor=white:fontsize=${Math.round(height / 26)}:` +
        `x=(w-text_w)/2:y=(h/2)+(text_h):shadowcolor=black@0.6:shadowx=2:shadowy=2`
    );
  }

  const args = [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-t', String(durationSeconds),
    '-vf', filtres.join(','),
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
      else reject(new AppError(`ffmpeg séquence de clôture échouée (code ${code}): ${stderr.slice(-400)}`, 500));
    });
    proc.on('error', (err) => reject(new AppError(`ffmpeg introuvable: ${err.message}`, 500)));
  });
}

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
  /** Langue du client — conditionne l'incrustation de texte. */
  langue?: string;
}): Promise<void> {
  const { inputPath, outputPath, totalDurationSeconds } = params;
  // Incrustation désactivée pour les écritures que `drawtext` ne sait pas
  // rendre (arabe : lettres détachées, ordre inversé). Un texte illisible
  // gravé dans la vidéo livrée serait pire que pas de texte ; la narration
  // porte déjà le message.
  const avecTexte = texteIncrustable(params.langue);
  const brand = avecTexte && params.brandName ? escapeDrawtext(params.brandName.slice(0, 40)) : '';
  const cta = avecTexte ? escapeDrawtext((params.ctaText || 'Découvrez-en plus').slice(0, 60)) : '';
  const offersLine = avecTexte ? escapeDrawtext(buildOffersOverlayLine(params.offerHighlights)) : '';
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

  if (cta) {
    filters.push(
      `[${videoLabel}]drawtext=fontfile='${fontPath}':text='${cta}':fontcolor=white:fontsize=36:` +
        `x=(w-text_w)/2:y=h-140:box=1:boxcolor=black@0.45:boxborderw=14:enable='gte(t,${ctaStart})'[vout]`
    );
    videoLabel = 'vout';
  }

  // Sans aucune incrustation, la vidéo est simplement recopiée : pas de
  // -filter_complex vide (ffmpeg le rejette) et le label brut '0:v' se mappe
  // SANS crochets, contrairement à un label de filtre.
  const aucunFiltre = filters.length === 0;
  const args = [
    '-y', '-i', inputPath,
    ...(aucunFiltre ? [] : ['-filter_complex', filters.join(';')]),
    '-map', aucunFiltre ? '0:v' : `[${videoLabel}]`, '-map', '0:a?',
    '-c:v', aucunFiltre ? 'copy' : 'libx264',
    ...(aucunFiltre ? [] : ['-preset', 'veryfast', '-pix_fmt', 'yuv420p']),
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
 * Le débit crédits a déjà eu lieu à l'enqueue (voir enqueueVideoAd). En cas
 * d'échec définitif (après le retry auto), aucun remboursement n'intervient :
 * la vidéo passe en 'failed' et ouvre un droit de relance gratuite.
 * Dispatch selon videoAd.mode vers le bon pipeline (Option 1 voix off, ou
 * Option 2 avatar) — la logique de statut est commune aux deux.
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
  // ── Composition du mini-film ──
  //
  // Le mini-film n'est pas un format d'avatar imposé : c'est un SCÉNARIO de
  // deux minutes, que le client compose. Deux choix possibles :
  //  · 'histoire'     — une histoire filmée avec des acteurs
  //  · 'decouverte'   — des scènes cinématiques sans acteur, centrées sur le
  //    produit et le site
  //  · 'presentateur' — un présentateur face caméra (flux avatar)
  //
  // Les deux premières empruntent le flux par scènes, seul capable de
  // produire du cinéma. Le cinéma et les acteurs sont EXCLUSIFS au
  // mini-film : c'est ce qui le distingue des formats courts.
  //
  // Deux usages visés, et le client doit comprendre lequel il choisit :
  // publicité cinématique pour un produit ou un service, ou contenu prêt à
  // publier sur les réseaux sociaux pour les créateurs.
  const compositionMiniFilm =
    videoAd.mode === 'mini_film'
      ? normaliserComposition((videoAd.brief as Record<string, unknown>)?.composition)
      : null;

  // Le flux à emprunter : voix off pur, ou avatar. Le mixte commence par
  // l'avatar, puis enchaîne sur des scènes sans présentateur.
  // Le film narratif emprunte le flux par SCÈNES : c'est lui qui sait
  // produire des personnages, des décors et de l'action. Le flux avatar, lui,
  // ne sait animer qu'un portrait face caméra — il ne peut pas raconter une
  // histoire.
  const utiliseVoixOffSeule =
    videoAd.mode === 'voix_off' ||
    compositionMiniFilm === 'histoire' ||
    compositionMiniFilm === 'decouverte';

  if (utiliseVoixOffSeule) {
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
      utiliseVoixOffSeule
        ? await runVoixOffPipeline(videoAd, videoAdId, niche, tmpFiles)
        : await runAvatarPipeline(videoAd, videoAdId, niche, tmpFiles, compositionMiniFilm);

    // Contrôle qualité final, juste avant l'upload/livraison client : durée
    // conforme, ratio conforme, pistes vidéo+audio réellement présentes et
    // non silencieuses. Deux issues possibles (voir video-qc.service.ts) :
    // - panne dure (blockingIssues non vide) → on jette nous-mêmes ci-dessous
    //   pour retomber dans le catch : rien n'est livré, les crédits restent
    //   acquis à la vidéo et une relance gratuite s'ouvre au client.
    // - défaut mineur seulement (minorIssues) → la vidéo EST livrée, avec un
    //   badge "résultat perfectible". Une nouvelle génération est possible au
    //   PLEIN TARIF (voir POST /video-ads/:id/relancer).
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

    // ── Ménage du stockage ──
    //
    // Si cette vidéo est COMPLÈTE, les plans archivés d'une tentative
    // précédente ne peuvent plus servir : une relance partielle n'a plus
    // d'objet. On les supprime pour ne pas accumuler des rushes inutiles.
    //
    // La vidéo finale livrée n'est jamais concernée : elle reste
    // téléchargeable par le client, indéfiniment.
    const videoComplete = !videoAd.partialDelivery || videoAd.partialDelivery.scenesFailed === 0;
    if (videoComplete) {
      await supprimerPlansArchives(videoAd);
      // La vidéo d'origine de la chaîne garde elle aussi des rushes devenus
      // inutiles puisque le client a maintenant sa version complète.
      if (videoAd.isRelaunchOf) {
        try {
          const precedente = await VideoAd.findById(videoAd.isRelaunchOf);
          if (precedente) {
            await supprimerPlansArchives(precedente);
            await precedente.save();
          }
        } catch (err) {
          console.warn('[video-pipeline] Ménage des rushes de la vidéo précédente impossible', err);
        }
      }
    }
    // Une livraison partielle (certains plans n'ont pas pu être générés) est
    // un défaut visible par le client : la pub est plus courte que prévu. Elle
    // doit donc apparaître comme "résultat perfectible" au même titre qu'un
    // défaut détecté par le contrôle qualité, sinon le client découvrirait une
    // vidéo incomplète sans aucune explication.
    const minorIssues = [...qc.minorIssues];
    if (videoAd.partialDelivery && videoAd.partialDelivery.scenesFailed > 0) {
      const { scenesGenerated, scenesFailed } = videoAd.partialDelivery;
      minorIssues.push(
        `Vidéo livrée avec ${scenesGenerated} plan(s) sur ${scenesGenerated + scenesFailed} : ${scenesFailed} plan(s) n'ont pas pu être générés.`
      );
    }

    videoAd.qcReport = {
      durationSeconds: qc.probe.durationSeconds,
      width: qc.probe.width,
      height: qc.probe.height,
      audioMeanVolumeDb: qc.audioMeanVolumeDb,
      checkedAt: new Date(),
      degraded: minorIssues.length > 0,
      minorIssues,
    };

    // Offre de relance corrective : uniquement si la vidéo a un défaut mineur
    // (contrôle qualité ou livraison partielle). Toujours au PLEIN TARIF : une
    // vidéo livrée et exploitable n'ouvre pas droit à une réparation gratuite
    // (voir getVideoAdRelaunchCost).
    if (minorIssues.length > 0) {
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
    // Échec définitif : rien n'a pu être livré.
    //
    // AUCUN remboursement en crédits n'existe dans le
    // système. À la place, le client conserve ses crédits sur CETTE vidéo et
    // dispose d'un droit de relance GRATUITE, illimité en nombre.
    //
    // Ce droit n'a pas besoin d'être stocké : il se déduit de l'état déjà
    // enregistré — des crédits ont été débités (creditsCharged > 0) et aucune
    // vidéo n'a jamais été livrée (finalVideoUrl absent). Voir
    // isFreeRelaunchEligible() dans video-ads.routes.ts.
    //
    // Un DÉLAI d'attente est imposé avant la relance manuelle : relancer
    // immédiatement pendant une panne fournisseur ne ferait qu'échouer à
    // nouveau. Voir FREE_RELAUNCH_COOLDOWN_MS.
    console.error(`[video-pipeline] Échec vidéo ${videoAdId}`, err);
    videoAd.status = 'failed';
    videoAd.errorMessage = (err as Error).message?.slice(0, 500);
    videoAd.failedAt = new Date();
    await videoAd.save();

    // L'erreur est rattrapée ici et ne remonte jamais au worker : c'est donc
    // ICI qu'il faut signaler l'échec, sinon l'administrateur ne serait
    // jamais informé d'une panne vidéo.
    const echec = classerEchec(err, 'generation-video');
    if (echec.alerter) {
      signalerIncident({
        composant: 'generation-video',
        erreur: `${echec.libelle} — ${(err as Error).message ?? String(err)}`,
        stack: (err as Error).stack,
        contexte: `generation-video:${videoAd.mode}:${videoAd.format}`,
        gravite: echec.gravite,
        categorie: echec.responsable,
      }).catch(() => {});
    }
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

    // ── Relance partielle : on NE réécrit PAS le scénario ──
    //
    // Si la vidéo arrive avec des plans déjà générés (hérités d'une relance
    // partielle, voir enqueueVideoAdRelaunch), on conserve tels quels le
    // découpage ET les plans réussis. Réécrire le scénario produirait de
    // nouvelles descriptions qui ne correspondraient plus aux plans conservés :
    // la vidéo mélangerait deux histoires différentes.
    const plansHerites = Array.isArray(videoAd.scenes) && videoAd.scenes.length > 0;

    if (!plansHerites) {
      const scenesRaw = await callClaude(
        'claude-sonnet-5',
        'Tu réponds uniquement en JSON valide, sans texte autour.',
        [
          {
            role: 'user',
            content: buildScenesPrompt(
              videoAd.brief,
              niche,
              nbScenes,
              videoAd.mode as VideoAdMode,
              videoAd.mode === 'mini_film'
                ? normaliserComposition((videoAd.brief as Record<string, unknown>)?.composition)
                : null
            ),
          },
        ],
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
    } else {
      console.log(
        `[video-pipeline] Relance partielle ${videoAdId} — ${videoAd.scenes.filter((s: any) => s.status === 'completed').length}/${videoAd.scenes.length} plans conservés`
      );
    }

    // URL live résolue une seule fois — réutilisée pour la capture réelle
    // (Playwright) ET pour l'extraction des vraies photos produit du site
    // (voir product-image-sourcing.service.ts).
    const liveSiteUrl = await resolveLiveSiteUrl(videoAd);

    // Plan "capture réelle" (mixte) : si une vraie URL de site est
    // disponible, on capture un scroll réel (Playwright) pour en faire un
    // des plans, à côté des plans générés par IA. Best-effort total : en
    // cas d'échec (site inaccessible, timeout...), ce plan reste 100% IA et
    // la génération de la vidéo n'est jamais impactée.
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

    // ── Génération des plans EN PARALLÈLE ──
    //
    // Les plans sont indépendants les uns des autres : les enchaîner en série
    // multipliait le temps d'attente du client par leur nombre. En parallèle,
    // la durée totale devient celle du plan le plus lent.
    //
    // Trois précautions indispensables :
    //  1. Les images de référence sont attribuées AVANT le parallélisme : le
    //     curseur cyclique donnerait un ordre non déterministe sinon.
    //  2. Les chemins de clips sont rangés par INDEX, jamais empilés dans
    //     l'ordre d'arrivée — sinon les plans se retrouveraient mélangés au
    //     montage.
    //  3. Les sauvegardes Mongoose sont sérialisées (queueSave) : deux save()
    //     simultanés sur le même document lèvent une ParallelSaveError.
    const sceneReferences: (ReferenceImage | null)[] = videoAd.scenes.map(() =>
      nextReferenceImage()
    );

    // Résultats rangés par index de scène (trous = plans échoués).
    const clipByIndex: (string | undefined)[] = new Array(videoAd.scenes.length).fill(undefined);
    const sceneErrors: (string | undefined)[] = new Array(videoAd.scenes.length).fill(undefined);

    // Sérialisation des écritures sur le document vidéo.
    let saveChain: Promise<unknown> = Promise.resolve();
    const queueSave = (): Promise<unknown> => {
      saveChain = saveChain.catch(() => undefined).then(() => videoAd.save());
      return saveChain;
    };

    const processScene = async (i: number): Promise<void> => {
      const scene = videoAd.scenes[i];

      // ── Plan hérité d'une relance partielle ──
      //
      // Ce plan a déjà abouti lors d'une tentative précédente et a été archivé
      // sur notre stockage. On le récupère tel quel : aucune régénération,
      // donc aucun coût fournisseur. C'est tout l'intérêt de la relance
      // partielle — seuls les plans manquants sont refaits.
      if (scene.status === 'completed' && scene.clipUrl && estUrlArchivee(scene.clipUrl)) {
        try {
          const localPath = await downloadToTmp(scene.clipUrl, `${videoAdId}_scene${i}_reuse.mp4`);
          tmpFiles.push(localPath);
          clipByIndex[i] = localPath;
          console.log(`[video-pipeline] Plan ${i} réutilisé (aucune régénération)`);
          return;
        } catch (err) {
          // Archive devenue illisible : on retombe sur une génération normale
          // plutôt que de livrer un trou.
          console.warn(
            `[video-pipeline] Plan ${i} archivé illisible, régénération`,
            err
          );
          scene.status = 'pending';
          scene.clipUrl = undefined;
          await queueSave();
        }
      }

      // Plan "capture réelle" déjà obtenu avant la boucle : on l'utilise
      // directement, pas de génération IA pour cette scène.
      if (i === captureSceneIndex && captureClipLocalPath) {
        scene.status = 'generating';
        await queueSave();
        try {
          const buffer = await fs.readFile(captureClipLocalPath);
          const uploaded = await uploadVideoAd(buffer, `${videoAdId}_scene${i}_capture`);
          scene.clipUrl = uploaded.url;
          scene.source = 'capture';
          scene.status = 'completed';
          await queueSave();
          clipByIndex[i] = captureClipLocalPath;
          return;
        } catch (err) {
          // Upload de traçabilité seulement — si ça échoue, on utilise quand
          // même le fichier local déjà capturé pour le montage.
          console.warn(`[video-pipeline] Upload de traçabilité (scène capture) indisponible`, err);
          scene.source = 'capture';
          scene.status = 'completed';
          await queueSave();
          clipByIndex[i] = captureClipLocalPath;
          return;
        }
      }

      let lastError: string | undefined;
      let succeeded = false;
      // Attentes pour cause de saturation du fournisseur. Comptées à part des
      // tentatives : une saturation n'est pas un échec (voir le catch).
      let busyWaits = 0;

      // Image de référence figée pour ce plan (même en cas de reprise, pour
      // que la reprise reproduise la même intention visuelle).
      const reference = sceneReferences[i];

      // 1 tentative + 1 retry automatique
      for (let attempt = 0; attempt < 2 && !succeeded; attempt++) {
        try {
          scene.status = 'generating';
          if (attempt === 1) scene.retried = true;
          await queueSave();

          const startImagePrompt = await buildImagePromptForScene(scene.prompt, videoAd.brief, reference?.kind);
          // Palier 2.0 : le premier plan conditionne toute l'animation. En
          // image-to-video, un défaut de cette image est amplifié sur 10
          // secondes de mouvement — 0,02 $ de plus par scène, négligeable face
          // au coût vidéo, pour un gain direct sur le rendu final.
          // La génération vidéo est réservée aux plans payants
          // (VIDEO_AD_ALLOWED_PLANS), donc jamais facturé à un essai gratuit.
          const generatedStart = await generateGrokImagine({
            prompt: startImagePrompt,
            aspectRatio: videoAd.aspectRatio,
            imageUrl: reference?.url,
            tier: 'v2',
          });
          if (reference) {
            scene.referenceImageUrl = reference.url;
            scene.referenceImageKind = reference.kind;
          }

          // ── Moteur vidéo : deux qualités ÉTANCHES, aucune bascule ──
          //
          // Premium  → Kling V3 Pro (fal.ai), audio off, 0,112 $/s.
          // Standard → Alexya "best", audio off, inchangé.
          //
          // Les deux ne se mélangent JAMAIS : un clip Kling et un clip Alexya
          // n'ont pas le même rendu (couleurs, grain, mouvement de caméra).
          // Les mélanger dans une même vidéo produirait un raccord visible au
          // milieu de la pub. Le moteur découle donc uniquement de la DURÉE
          // (voir getVideoEngineForFormat), fixée à la commande et jamais
          // modifiée en cours de génération.
          //
          // Dans les deux cas le son du modèle est désactivé : la voix vient
          // toujours de notre narration TTS ajoutée au montage (Architecture
          // v6 section 8).
          let clip: { outputUrl: string };
          // Le moteur découle de la DURÉE, jamais d'un choix de qualité :
          // formats courts sur Alexya, formats longs sur Kling.
          if (getVideoEngineForFormat(videoAd.format as VideoAdFormat) === 'kling') {
            clip = await generateKlingVideoClip({
              prompt: scene.prompt,
              imageUrl: generatedStart.url,
              durationSeconds: CLIP_DURATION_SECONDS,
            });
            scene.engine = 'kling_v3_pro';
          } else {
            // Alexya exige un upload presign de l'image de départ : elle
            // n'accepte pas une URL externe brute (contrairement à fal.ai).
            const alexyaStartUrl = await uploadVideoStartFrameFromUrl(generatedStart.url);
            clip = await generateAlexyaVideoClip({
              prompt: scene.prompt,
              mode: 'best',
              duration: CLIP_DURATION_SECONDS,
              startImageUrl: alexyaStartUrl,
              soundEnabled: false,
            });
            scene.engine = 'alexya_best';
          }

          const localPath = await downloadToTmp(clip.outputUrl, `${videoAdId}_scene${i}.mp4`);
          tmpFiles.push(localPath);

          // Le clip reste LOCAL à ce stade — aucun upload.
          //
          // Archiver systématiquement chaque plan saturerait le stockage pour
          // rien : la grande majorité des vidéos aboutissent complètes, et
          // leurs plans intermédiaires ne resserviront jamais. On n'archive
          // qu'après le montage, et seulement si la vidéo est incomplète (voir
          // archiverPlansPourRelance). Les fichiers locaux suffisent jusque-là,
          // le montage ayant lieu dans le même job.
          scene.clipUrl = clip.outputUrl;
          scene.source = 'ai';
          scene.status = 'completed';
          succeeded = true;
          await queueSave();

          // Rangé par INDEX de scène, jamais empilé : en parallèle, l'ordre
          // d'arrivée n'est pas l'ordre du scénario, et un simple push
          // mélangerait les plans au montage.
          clipByIndex[i] = localPath;
        } catch (err) {
          // ── Saturation ≠ échec ──
          //
          // FalaiBusyError signifie que fal n'a pas pu DÉMARRER la génération
          // (capacité saturée), pas qu'elle a raté. La traiter comme un échec
          // serait grave : la scène serait perdue, la vidéo déclarée en panne,
          // et une relance gratuite ouverte — alors que rien n'est cassé et
          // qu'il suffisait d'attendre.
          //
          // On ne consomme donc PAS la tentative : on patiente et on refait le
          // même essai. Seuls les vrais échecs de génération consomment une
          // tentative.
          if (err instanceof FalaiBusyError || err instanceof AlexyaBusyError) {
            busyWaits += 1;
            console.warn(
              `[video-pipeline] Scène ${i} — fournisseur saturé (attente ${busyWaits}/${MAX_BUSY_WAITS}), la tentative n'est pas consommée`
            );
            if (busyWaits <= MAX_BUSY_WAITS) {
              attempt -= 1; // la tentative est rejouée à l'identique
              await new Promise((r) => setTimeout(r, BUSY_RETRY_DELAY_MS));
              continue;
            }
            // Saturation persistante : on abandonne, mais avec un message qui
            // dit bien que le service est occupé, pas défaillant.
            lastError =
              'Service de génération vidéo saturé — réessayez dans quelques minutes.';
            break;
          }

          lastError = (err as Error).message;
          console.warn(`[video-pipeline] Scène ${i} tentative ${attempt + 1} échouée`, err);
        }
      }

      if (!succeeded) {
        // On NE lève PAS d'exception : un plan raté ne doit pas détruire les
        // autres, qui sont déjà générés et payés. L'échec est enregistré et le
        // montage décidera s'il reste de quoi livrer (voir plus bas).
        scene.status = 'failed';
        scene.error = lastError;
        sceneErrors[i] = lastError;
        await queueSave();
        console.warn(`[video-pipeline] Scène ${i} abandonnée : ${lastError}`);
      }
    };

    // Lancement parallèle, borné par la limite du fournisseur concerné.
    await runWithConcurrency(
      videoAd.scenes.length,
      getSceneConcurrency(videoAd.format as VideoAdFormat),
      processScene
    );
    // On attend que la dernière écriture sérialisée soit passée avant de lire
    // l'état des scènes.
    await saveChain.catch(() => undefined);

    // ── Livraison partielle ──
    //
    // On fait le maximum pour livrer quelque chose. Une
    // pub dont 2 plans sur 3 ont abouti reste exploitable par le client ; tout
    // jeter serait un gâchis pour lui comme pour NexAI (les plans réussis ont
    // déjà été payés au fournisseur).
    //
    // L'ordre des plans est préservé grâce à l'indexation : on retire
    // simplement les trous laissés par les plans échoués.
    const clipLocalPathsOrdered = clipByIndex.filter(
      (p): p is string => typeof p === 'string'
    );
    const scenesEchouees = sceneErrors.filter(Boolean).length;

    // ── Seuil minimal de livraison ──
    //
    // On ne livre que si le contenu ANIMÉ atteint la moitié du format
    // commandé. Livrer un mini-film de 120s réduit à 35s serait pire que ne
    // rien livrer : le client a payé le format le plus long et le constaterait
    // immédiatement.
    //
    // Le seuil se calcule sur les plans animés SEULS, jamais avec la séquence
    // de clôture : sinon celle-ci servirait à masquer le manque.
    const format = videoAd.format as VideoAdFormat;
    const secondesAnimees = clipLocalPathsOrdered.length * CLIP_DURATION_SECONDS;

    if (clipLocalPathsOrdered.length > 0 && !peutEtreLivree(format, secondesAnimees)) {
      console.warn(
        `[video-pipeline] ${videoAdId} sous le seuil de livraison — ${secondesAnimees}s animées pour un format ${format}`
      );
      throw new AppError(
        `Contenu animé insuffisant pour livrer ce format (${secondesAnimees}s sur ${dureeCibleSecondes(format)}s).`,
        502
      );
    }

    if (clipLocalPathsOrdered.length === 0) {
      // Aucun plan exploitable : c'est le seul cas d'échec total. Les crédits
      // restent acquis à la vidéo et une relance GRATUITE s'ouvre au client
      // (voir enqueueVideoAdRelaunch).
      throw new AppError(
        `Aucun plan n'a pu être généré : ${sceneErrors.find(Boolean) ?? 'erreur inconnue'}`,
        502
      );
    }

    if (scenesEchouees > 0) {
      // Vidéo livrable mais incomplète : elle part avec le badge "résultat
      // perfectible" déjà géré par l'agent qualité, et le client peut en
      // refaire une au plein tarif.
      videoAd.partialDelivery = {
        scenesGenerated: clipLocalPathsOrdered.length,
        scenesFailed: scenesEchouees,
        reason: sceneErrors.find(Boolean),
      };

      // Vidéo incomplète : c'est le SEUL cas où les plans réussis sont
      // archivés. Ils permettront à une relance de ne régénérer que les plans
      // manquants, sans repayer les autres. Ils seront supprimés dès qu'une
      // relance aura complété la vidéo, ou que les relances seront épuisées
      // (voir supprimerPlansArchives).
      await archiverPlansPourRelance(videoAd, videoAdId, clipByIndex);

      await videoAd.save();
      console.warn(
        `[video-pipeline] Livraison partielle ${videoAdId} — ${clipLocalPathsOrdered.length}/${videoAd.scenes.length} plans`
      );
    }

    clipLocalPaths.push(...clipLocalPathsOrdered);

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

    // ── Séquence de clôture ──
    //
    // Ajoutée UNIQUEMENT si des plans manquent, pour que la vidéo atteigne (ou
    // approche) la durée commandée. Construite localement, donc sans coût ni
    // attente, et sans risque d'échec de génération.
    //
    // Placée en FIN : c'est une convention publicitaire (carte de fin logo +
    // produit). Insérée au milieu, une image fixe entre deux plans animés se
    // lirait comme un défaut.
    const dureeCloture = dureeSequenceCloture(format, secondesAnimees);
    if (dureeCloture > 0) {
      try {
        // Priorité : image produit (la plus vendeuse), sinon capture du site,
        // sinon logo.
        const imageCloture =
          referencePool.productImages[0]?.url ||
          referencePool.mockupImages[0]?.url ||
          videoAd.logoUrl;

        if (imageCloture) {
          const closingSrcPath = await downloadToTmp(imageCloture, `${videoAdId}_closing_src`);
          tmpFiles.push(closingSrcPath);
          const closingClipPath = path.join(os.tmpdir(), `${videoAdId}_closing.mp4`);
          tmpFiles.push(closingClipPath);

          const briefCloture = videoAd.brief as { brandName?: string; ctaText?: string };
          await runFfmpegBuildClosingCardClip({
            imagePath: closingSrcPath,
            outputPath: closingClipPath,
            width: target.width,
            height: target.height,
            fps: target.fps,
            durationSeconds: dureeCloture,
            brandName: briefCloture?.brandName,
            ctaText: briefCloture?.ctaText,
            langue: await langueDuProprietaire(videoAd.userId),
          });

          crossfadeClips.push({ path: closingClipPath, durationSeconds: dureeCloture });
          console.log(
            `[video-pipeline] Séquence de clôture ajoutée (${dureeCloture}s) — ${videoAdId}`
          );
        }
      } catch (err) {
        // La séquence est un complément : si elle échoue, on livre la vidéo
        // plus courte plutôt que de tout perdre.
        console.warn('[video-pipeline] Séquence de clôture indisponible', err);
      }
    }

    const { totalDurationSeconds } = await runFfmpegCrossfadeConcat(crossfadeClips, concatPath, target);

    // Narration TTS : script généré par Claude, calibré sur la durée totale,
    // synthétisé en voix off — un seul flux audio pour tout le mode.
    let videoWithVoicePath = concatPath;
    // Conservé hors du bloc try pour le contrôle qualité voix/musique plus bas
    // (vérifier l'équilibre voix/musique n'a de sens que si une voix a bien
    // été générée — sinon rien à comparer, la vidéo part silencieuse+musique).
    let narrationLocalPathForQc: string | undefined;
    try {
      const langueVideo = await langueDuProprietaire(videoAd.userId);
      const script = await buildNarrationScript(
        videoAd.brief,
        niche,
        totalDurationSeconds,
        langueVideo
      );
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
        langue: await langueDuProprietaire(videoAd.userId),
      });
      finalPath = withCtaPath;
    } catch (err) {
      // Jamais bloquant : la vidéo part sans CTA incrusté plutôt que d'échouer.
      console.warn(`[video-pipeline] Overlay CTA indisponible, livraison sans CTA incrusté`, err);
    }

    return finalPath;
}

/**
 * Avatar pub (30s/60s/120s) et Mini-film/série (120s uniquement, Pro Max).
 * Portrait généré par Grok Imagine + narration TTS + lipsync FalAI Kling
 * Avatar. Mini-film chaîne 2 segments Pro de 60s max (contrainte
 * fournisseur, voir falai-avatar.service.ts) et les concatène.
 */
async function runAvatarPipeline(
  videoAd: HydratedDocument<any>,
  videoAdId: string,
  niche: string,
  tmpFiles: string[],
  /** Composition du mini-film. Seul 'presentateur' passe par ce flux. */
  compositionMiniFilm?: CompositionMiniFilm | null
): Promise<string> {
  const isScenario = videoAd.mode === 'mini_film';
  // Qualité de l'avatar FalAI : 'pro' pour les formats longs (60 s et le
  // mini-film), 'standard' pour les formats courts. Suit la même logique que
  // le moteur vidéo — la qualité découle de la durée, jamais d'un choix.
  const quality: AvatarQuality =
    getVideoEngineForFormat(videoAd.format as VideoAdFormat) === 'kling' ? 'pro' : 'standard';
  // Durée déduite du format, SAUF pour le test de l'essai gratuit qui
  // impose 8 secondes (voir video-test.service.ts) — c'est ce qui maintient
  // son coût réel autour de 0,46 $.
  const brief0 = videoAd.brief as Record<string, unknown> | undefined;
  const dureeForcee =
    typeof brief0?.durationSecondsOverride === 'number' ? brief0.durationSecondsOverride : null;
  // Table explicite plutôt qu'une cascade de ternaires : celle-ci renvoyait
  // 120 pour TOUTE durée non prévue, si bien qu'un 20 s était produit en
  // deux minutes, avec une narration six fois trop longue.
  const DUREES: Record<string, number> = { '20s': 20, '30s': 30, '60s': 60, '120s': 120 };
  const totalDurationSeconds = dureeForcee ?? DUREES[String(videoAd.format)] ?? 30;

  // 1. Script + portrait du présentateur (Claude + Grok Imagine)
  const script = await buildNarrationScript(
    videoAd.brief,
    niche,
    totalDurationSeconds
  );
  videoAd.narrationScript = script;
  await videoAd.save();

  const brief = videoAd.brief as any;
  const brand = String(brief?.brandName || brief?.siteMeta?.title || '');
  // Présentateur choisi par le client. Kling AI Avatar n'a pas de catalogue :
  // il anime le portrait qu'on lui fournit. Le choix est donc entièrement
  // ouvert — genre, carnation, âge, style — et mémorisé sur le compte pour
  // que le présentateur reste le même d'une vidéo à l'autre.
  const proprietaire = await User.findById(videoAd.userId).select('plan avatarPrefere');
  const choixAvatar = normaliserChoixAvatar(brief?.avatar ?? proprietaire?.avatarPrefere);
  const portraitPrompt = construirePromptPortrait(choixAvatar, brand);
  // Palier image du portrait : 2.0 pour les plans payants (le portrait est
  // ensuite animé par Kling Avatar, et tout défaut y est amplifié), mais
  // palier standard pour le TEST 8s de l'essai gratuit — il passe par ce même
  // pipeline en mode 'avatar_pub' (voir video-test.service.ts) et doit rester
  // au coût d'acquisition le plus bas possible.
  const estTestEssai = proprietaire?.plan === 'trial';
  const portrait = await generateGrokImagine({
    prompt: portraitPrompt,
    aspectRatio: videoAd.aspectRatio,
    tier: estTestEssai ? 'standard' : 'v2',
  });
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
  // Pour mini_film (120s) : 2 segments de 60s exactement.
  // En composition mixte, un seul segment avatar : la seconde minute est
  // produite sans présentateur (voir plus bas).
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
    const overlayDuration = totalDurationSeconds;
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
      langue: await langueDuProprietaire(videoAd.userId),
    });
    finalPath = withCtaPath;
  } catch (err) {
    console.warn(`[video-pipeline] Overlay CTA/offres indisponible (Avatar), livraison sans overlay`, err);
  }

  return finalPath;
}
