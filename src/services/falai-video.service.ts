import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * FalAI — Kling Video V3 Pro (image-to-video).
 * Doc : https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video
 *
 * Moteur du tier PREMIUM en mode voix off. Anime une image de départ (générée
 * par Grok Imagine 2.0) en un clip vidéo.
 *
 * Pourquoi Kling V3 Pro et pas V3 Turbo Pro
 * -----------------------------------------
 * NexAI coupe TOUJOURS l'audio du modèle vidéo : la narration vient
 * d'ElevenLabs. Or seul le tier "pro" propose un tarif audio désactivé :
 *   - v3/pro       : 0,112 $/s audio off  ← retenu
 *   - v3/turbo/pro : 0,14 $/s (tarif unique, pas d'option audio)
 * Le "pro" est donc à la fois moins cher ET le modèle haut de gamme ; "turbo"
 * est la variante optimisée pour la latence, qui n'apporte rien ici puisque le
 * pipeline est asynchrone avec polling.
 *
 * Pourquoi ce service remplace Alexya "cinematic" sur le Premium
 * -------------------------------------------------------------
 * Meilleure cohérence de mouvement et fidélité à l'image de départ, pour un
 * coût inférieur (0,112 $/s contre 0,136 $/s). Alexya reste le moteur EXCLUSIF
 * du tier Standard (mode "best") : les deux qualités sont volontairement
 * étanches, aucune bascule entre elles — un clip et son moteur ne se mélangent
 * jamais au sein d'une même vidéo.
 *
 * Simplification héritée : contrairement à Alexya, fal.ai accepte une URL
 * publique directe comme image de départ. L'étape presign/upload
 * (uploadVideoStartFrameFromUrl) n'est donc pas nécessaire sur ce chemin.
 */

const FALAI_QUEUE_BASE = 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video';

/** Tarif FalAI, audio désactivé. Voir l'en-tête pour le choix du modèle. */
const KLING_V3_PRO_RATE_PER_SECOND_USD = 0.112;

/** Bornes de durée acceptées par le modèle (enum fournisseur : 3 à 15s). */
export const KLING_MIN_DURATION_SECONDS = 3;
export const KLING_MAX_DURATION_SECONDS = 15;

function authHeaders() {
  if (!env.FALAI_API_KEY) {
    throw new AppError('FALAI_API_KEY manquante — configure-la sur Render', 503);
  }
  return {
    Authorization: `Key ${env.FALAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export interface GenerateKlingClipParams {
  /** URL publique de l'image de départ (Grok Imagine 2.0, déjà hébergée). */
  imageUrl: string;
  /** Description du plan à animer. */
  prompt: string;
  /** Durée du clip en secondes (3 à 15). */
  durationSeconds: number;
}

/**
 * Erreur de SATURATION — à ne jamais confondre avec un échec de génération.
 *
 * Levée quand fal.ai refuse ou diffère la demande faute de capacité (429,
 * 503, file d'attente qui s'éternise). La vidéo n'a pas échoué : elle n'a pas
 * encore pu commencer, ou attend son tour.
 *
 * Distinction critique : un échec ouvre un droit de relance gratuite et
 * consomme une tentative ; une saturation doit simplement être ré-essayée.
 * Les confondre ferait croire au client que le service est cassé alors qu'il
 * est seulement occupé.
 */
export class FalaiBusyError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}

/** Codes HTTP qui signifient « occupé, réessaie », jamais « échoué ». */
const BUSY_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

/**
 * Temps maximal d'ATTENTE EN FILE chez fal (statut IN_QUEUE).
 *
 * Généreux, parce que la limite de concurrence par défaut de fal est de 1
 * génération simultanée par compte : une 2ème vidéo lancée en parallèle attend
 * légitimement que la 1ère se termine. Couper trop tôt transformerait une
 * simple attente en faux échec.
 *
 * 10 minutes = environ 5 à 10 fois la durée normale d'un clip, donc très large
 * en usage réel. Volontairement pas plus : chaque génération occupe un des 2
 * créneaux de la queue BullMQ, et une attente trop longue bloquerait les
 * autres clients.
 */
const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;

/**
 * Temps maximal de GÉNÉRATION effective (statut IN_PROGRESS), une fois que
 * fal a réellement commencé. Au-delà, c'est une anomalie, pas de l'attente.
 */
const MAX_PROGRESS_WAIT_MS = 10 * 60 * 1000;

/** Intervalle entre deux interrogations de statut. */
const POLL_INTERVAL_MS = 3000;

/**
 * Interroge fal jusqu'à obtention du résultat.
 *
 * Deux budgets de temps SÉPARÉS : l'attente en file ne consomme pas le budget
 * de génération, et inversement. C'est ce qui empêche une vidéo légitimement
 * mise en attente d'être déclarée en échec.
 */
async function pollFalaiQueue(
  requestId: string
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  const statusUrl = `${FALAI_QUEUE_BASE}/requests/${requestId}/status`;
  const resultUrl = `${FALAI_QUEUE_BASE}/requests/${requestId}`;

  let queueWaitedMs = 0;
  let progressWaitedMs = 0;
  // Erreurs réseau transitoires tolérées avant d'abandonner.
  let consecutiveNetworkErrors = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let res: Response;
    try {
      res = await fetch(statusUrl, { headers: authHeaders() });
    } catch {
      // Coupure réseau passagère : on retente, ce n'est pas un échec de
      // génération. La vidéo continue de se générer chez fal pendant ce temps.
      consecutiveNetworkErrors += 1;
      if (consecutiveNetworkErrors >= 20) {
        throw new FalaiBusyError(
          'FalAI injoignable pour le suivi de la génération. La demande peut encore aboutir.'
        );
      }
      progressWaitedMs += POLL_INTERVAL_MS;
      continue;
    }
    consecutiveNetworkErrors = 0;

    if (!res.ok) {
      // Statut illisible pour cause de saturation : on attend, on n'échoue pas.
      if (BUSY_STATUS_CODES.has(res.status)) {
        queueWaitedMs += POLL_INTERVAL_MS;
        if (queueWaitedMs >= MAX_QUEUE_WAIT_MS) {
          throw new FalaiBusyError(
            'FalAI reste saturé. La génération n\u2019a pas pu démarrer.'
          );
        }
        continue;
      }
      // 401/403/404 : problème réel de configuration ou de requête.
      const text = await res.text().catch(() => '');
      throw new AppError(
        `FalAI : statut illisible (${res.status}) ${text.slice(0, 200)}`,
        502
      );
    }

    const data = (await res.json().catch(() => ({}))) as { status?: string };

    if (data.status === 'COMPLETED') {
      const resultRes = await fetch(resultUrl, { headers: authHeaders() });
      if (!resultRes.ok) {
        throw new AppError(`FalAI : échec récupération résultat (${resultRes.status})`, 502);
      }
      const result = (await resultRes.json()) as {
        video?: { url?: string };
        thumbnail?: { url?: string };
      };
      if (!result.video?.url) {
        throw new AppError('FalAI : réponse complétée sans URL vidéo', 502);
      }
      return { outputUrl: result.video.url, thumbnailUrl: result.thumbnail?.url };
    }

    // ÉCHEC RÉEL et définitif : le modèle a rejeté la demande.
    if (data.status === 'ERROR' || data.status === 'FAILED') {
      throw new AppError('FalAI : génération vidéo Kling échouée (status ERROR)', 502);
    }

    // IN_QUEUE : la demande attend son tour. Budget d'attente, pas d'échec.
    if (data.status === 'IN_QUEUE') {
      queueWaitedMs += POLL_INTERVAL_MS;
      if (queueWaitedMs >= MAX_QUEUE_WAIT_MS) {
        throw new FalaiBusyError(
          'FalAI : la génération est restée en file d\u2019attente trop longtemps.'
        );
      }
      continue;
    }

    // IN_PROGRESS (ou statut inconnu) : la génération tourne vraiment.
    progressWaitedMs += POLL_INTERVAL_MS;
    if (progressWaitedMs >= MAX_PROGRESS_WAIT_MS) {
      throw new AppError('FalAI : timeout génération vidéo Kling', 504);
    }
  }
}

/**
 * Génère UN clip vidéo à partir d'une image de départ.
 *
 * L'audio natif du modèle n'est jamais demandé : aucun champ audio n'est
 * envoyé, ce qui garantit le tarif audio off et surtout qu'aucun son parasite
 * ne vienne concurrencer la narration ElevenLabs ajoutée au montage.
 */
export async function generateKlingVideoClip(
  params: GenerateKlingClipParams
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  const duration = Math.min(
    KLING_MAX_DURATION_SECONDS,
    Math.max(KLING_MIN_DURATION_SECONDS, Math.round(params.durationSeconds))
  );

  // Soumission avec reprise sur saturation.
  //
  // fal limite par défaut à 1 génération simultanée par compte. Deux vidéos
  // premium lancées en parallèle par la queue BullMQ (concurrency: 2) peuvent
  // donc se heurter à un refus temporaire. Ce refus n'est PAS un échec de
  // génération : on patiente et on resoumet, avec un délai croissant.
  const MAX_SUBMIT_ATTEMPTS = 6;
  let res: Response | null = null;

  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // 5s, 10s, 20s, 40s, 80s — laisse le temps à la génération en cours de
      // se terminer et de libérer le créneau.
      const backoffMs = 5000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    try {
      res = await fetch(FALAI_QUEUE_BASE, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          // ATTENTION — le champ s'appelle bien `start_image_url` sur v3/pro.
          // Le tier v3/turbo/pro utilise `image_url` : les deux endpoints ont
          // des contrats DIFFÉRENTS. Envoyer `image_url` ici fait échouer 100%
          // des appels (paramètre requis manquant).
          start_image_url: params.imageUrl,
          prompt: params.prompt.slice(0, 2500),
          // `duration` est un enum de CHAÎNES ("3".."15"), pas un nombre.
          duration: String(duration),
          // Audio natif explicitement désactivé — la narration vient
          // d'ElevenLabs. Indispensable aussi pour le tarif : 0,112 $/s audio
          // off contre 0,168 $/s audio on. Le défaut de l'API est `true`, donc
          // ne jamais omettre ce champ (+50% de coût silencieux).
          generate_audio: false,
        }),
      });
    } catch {
      // Réseau indisponible : on retente, ce n'est pas un rejet du modèle.
      res = null;
      continue;
    }

    if (res.ok) break;

    // Saturation → on retente. Toute autre erreur → échec réel immédiat.
    if (!BUSY_STATUS_CODES.has(res.status)) {
      const text = await res.text();
      throw new AppError(`FalAI Kling error ${res.status}: ${text.slice(0, 400)}`, 502);
    }
    res = null;
  }

  if (!res) {
    throw new FalaiBusyError(
      'Le service de génération vidéo est momentanément saturé. La demande sera relancée automatiquement.'
    );
  }

  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) {
    throw new AppError('FalAI : pas de request_id retourné pour la génération vidéo', 502);
  }

  return pollFalaiQueue(data.request_id);
}

/** Coût FalAI réel (en $) pour monitoring — pas facturé au client tel quel. */
export function estimateKlingCostUsd(durationSeconds: number): number {
  return Math.round(durationSeconds * KLING_V3_PRO_RATE_PER_SECOND_USD * 100) / 100;
}
