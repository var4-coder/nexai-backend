import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * AlexyaAI — génération vidéo.
 * Doc officielle : https://alexya.ai/api-docs
 *
 * POST /api/v1/video/generate  (async, 202 + poll_url)
 * - mode "best"      : silencieux, duration 5 ou 10s uniquement, pas de son
 * - mode "cinematic" : duration 3 à 15s, sound_enabled optionnel.
 *   Supporté par le contrat de la fonction, mais NexAI n'appelle Alexya qu'en
 *   mode "best" : ce service sert uniquement le tier Standard. Le tier Premium
 *   passe par Kling V3 Pro (voir falai-video.service.ts).
 *
 * L'image de départ ne peut PAS être une URL externe brute : elle doit être
 * uploadée via /api/v1/uploads/presign (kind: "video_start_frame"), puis on
 * utilise le public_url retourné dans start_image_url.
 *
 * Coûts Alexya (crédits internes Alexya, pas NexAI) :
 * - best      : 28 cr/s   (280cr pour 10s)
 * - cinematic + son : 63 cr/s (315cr pour 5s)
 */

const ALEXYA_BASE = 'https://alexya.ai/api/v1';

/**
 * Erreur de SATURATION Alexya — à ne jamais confondre avec un échec.
 *
 * Levée quand le compte a atteint sa limite de générations simultanées (5 par
 * défaut, code `concurrent_limit_exceeded`) ou son débit de requêtes. La
 * génération n'a pas raté : elle n'a pas pu démarrer.
 *
 * Le pipeline la traite comme la FalaiBusyError de Kling : on attend et on
 * réessaie, sans consommer de tentative et sans marquer le plan en échec.
 */
export class AlexyaBusyError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}

function authHeaders() {
  if (!env.ALEXYA_API_KEY) {
    throw new AppError('ALEXYA_API_KEY manquante — configure-la sur Render', 503);
  }
  return {
    Authorization: `Bearer ${env.ALEXYA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Upload une image de départ (buffer, ex: frame extraite ou image générée)
 * vers le stockage Alexya via le flux presign obligatoire.
 */
export async function uploadVideoStartFrame(
  buffer: Buffer,
  contentType: string = 'image/jpeg'
): Promise<string> {
  const presignRes = await fetch(`${ALEXYA_BASE}/uploads/presign`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ kind: 'video_start_frame', content_type: contentType }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new AppError(`Alexya presign error ${presignRes.status}: ${text.slice(0, 400)}`, 502);
  }

  const presign = (await presignRes.json()) as { upload_url?: string; public_url?: string };
  if (!presign.upload_url || !presign.public_url) {
    throw new AppError('Alexya : réponse presign invalide (upload_url/public_url manquants)', 502);
  }

  const putRes = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
  });

  if (!putRes.ok) {
    throw new AppError(`Alexya : échec upload binaire (${putRes.status})`, 502);
  }

  return presign.public_url;
}

/** Upload à partir d'une URL déjà accessible (télécharge puis relaie vers Alexya). */
export async function uploadVideoStartFrameFromUrl(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new AppError(`Impossible de télécharger l'image de départ (${res.status})`, 502);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadVideoStartFrame(buffer, contentType);
}

/** Codes HTTP qui signifient « occupé, réessaie », jamais « échoué ». */
const BUSY_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

/**
 * Attente maximale EN FILE (statut queued/pending) chez Alexya.
 *
 * Distinct du temps de génération : avec 5 générations simultanées autorisées
 * par compte et plusieurs plans lancés en parallèle, une demande peut
 * légitimement patienter. La couper trop tôt transformerait une simple attente
 * en faux échec, ce qui déclencherait à tort une panne côté client.
 */
const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;

/** Temps maximal de génération effective, une fois réellement démarrée. */
const MAX_PROGRESS_WAIT_MS = 10 * 60 * 1000;

const POLL_INTERVAL_MS = 3000;

/**
 * Interroge Alexya jusqu'au résultat, avec DEUX budgets de temps séparés :
 * l'attente en file ne consomme pas le budget de génération, et inversement.
 * C'est ce qui empêche un plan légitimement mis en attente d'être déclaré en
 * échec (même principe que pour Kling, voir falai-video.service.ts).
 */
async function pollVideoGeneration(
  pollUrl: string
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  let queueWaitedMs = 0;
  let progressWaitedMs = 0;
  let erreursReseau = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let res: Response;
    try {
      res = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${env.ALEXYA_API_KEY}` },
      });
    } catch {
      // Coupure réseau passagère : la génération continue chez Alexya.
      erreursReseau += 1;
      if (erreursReseau >= 20) {
        throw new AlexyaBusyError(
          'Alexya injoignable pour le suivi de la génération. La demande peut encore aboutir.'
        );
      }
      progressWaitedMs += POLL_INTERVAL_MS;
      continue;
    }
    erreursReseau = 0;

    if (!res.ok) {
      if (BUSY_STATUS_CODES.has(res.status)) {
        queueWaitedMs += POLL_INTERVAL_MS;
        if (queueWaitedMs >= MAX_QUEUE_WAIT_MS) {
          throw new AlexyaBusyError('Alexya reste saturé, la génération n\'a pas pu démarrer.');
        }
        continue;
      }
      // 401/403/404 : problème réel de configuration ou de requête.
      throw new AppError(`Alexya : statut illisible (${res.status})`, 502);
    }

    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      output_url?: string;
      thumbnail_url?: string;
      error?: string;
    };

    if (data.status === 'completed' && data.output_url) {
      return { outputUrl: data.output_url, thumbnailUrl: data.thumbnail_url };
    }

    // ÉCHEC RÉEL : le modèle a rejeté la demande.
    if (data.status === 'failed') {
      throw new AppError(`Alexya génération vidéo échouée: ${data.error || 'unknown'}`, 502);
    }

    // En file d'attente : budget d'attente, pas d'échec.
    if (data.status === 'queued' || data.status === 'pending') {
      queueWaitedMs += POLL_INTERVAL_MS;
      if (queueWaitedMs >= MAX_QUEUE_WAIT_MS) {
        throw new AlexyaBusyError(
          'Alexya : la génération est restée en file d\'attente trop longtemps.'
        );
      }
      continue;
    }

    // processing (ou statut inconnu) : la génération tourne vraiment.
    progressWaitedMs += POLL_INTERVAL_MS;
    if (progressWaitedMs >= MAX_PROGRESS_WAIT_MS) {
      throw new AppError('Alexya : timeout génération vidéo', 504);
    }
  }
}

export interface GenerateVideoClipParams {
  prompt: string;
  mode: 'best' | 'cinematic';
  /** best: 5 ou 10 uniquement. cinematic: 3 à 15. */
  duration: number;
  startImageUrl: string; // doit déjà être un public_url Alexya (via uploadVideoStartFrame*)
  soundEnabled?: boolean; // uniquement valide en mode cinematic
  endImageUrl?: string; // cinematic single-shot uniquement
}

export async function generateAlexyaVideoClip(
  params: GenerateVideoClipParams
): Promise<{ outputUrl: string; thumbnailUrl?: string }> {
  if (params.mode === 'best' && params.duration !== 5 && params.duration !== 10) {
    throw new AppError('Mode "best" : durée autorisée 5 ou 10 secondes uniquement.', 400);
  }
  if (params.mode === 'cinematic' && (params.duration < 3 || params.duration > 15)) {
    throw new AppError('Mode "cinematic" : durée autorisée entre 3 et 15 secondes.', 400);
  }
  if (params.soundEnabled && params.mode !== 'cinematic') {
    throw new AppError('Le son n\'est disponible qu\'en mode "cinematic".', 400);
  }

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    mode: params.mode,
    duration: params.duration,
    start_image_url: params.startImageUrl,
  };
  if (params.mode === 'cinematic') {
    if (params.soundEnabled !== undefined) body.sound_enabled = params.soundEnabled;
    if (params.endImageUrl) body.end_image_url = params.endImageUrl;
  }

  // Soumission avec reprise sur saturation.
  //
  // Limites documentées Alexya : 5 générations concurrentes par compte,
  // 20 requêtes / 60s par clé, 1 000 requêtes / 60 min par compte. Un
  // dépassement renvoie un 429 (code `concurrent_limit_exceeded` pour la
  // concurrence).
  //
  // Un 429 signifie « occupé », PAS « échoué » : la génération n'a pas encore
  // démarré. La compter comme un échec ferait perdre le plan et déclencherait
  // à tort une panne côté client. On attend donc qu'un créneau se libère.
  const MAX_SUBMIT_ATTEMPTS = 6;
  let res: Response | null = null;

  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // 5s, 10s, 20s, 40s, 80s — le temps qu'une génération en cours libère
      // un des 5 créneaux du compte.
      await new Promise((r) => setTimeout(r, 5000 * Math.pow(2, attempt - 1)));
    }

    try {
      res = await fetch(`${ALEXYA_BASE}/video/generate`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    } catch {
      // Réseau indisponible : on retente, ce n'est pas un rejet du modèle.
      res = null;
      continue;
    }

    if (res.status === 202) break;

    // 429 (concurrence/débit) et 5xx transitoires → on patiente et on retente.
    if (res.status !== 429 && res.status < 500) {
      const text = await res.text();
      throw new AppError(`Alexya video error ${res.status}: ${text.slice(0, 400)}`, 502);
    }
    res = null;
  }

  if (!res) {
    throw new AlexyaBusyError(
      'Alexya est momentanément saturé (limite de générations simultanées). La demande sera relancée automatiquement.'
    );
  }

  const data = (await res.json()) as { poll_url?: string; id?: string };
  const pollUrl = data.poll_url || (data.id ? `${ALEXYA_BASE}/generations/${data.id}` : null);
  if (!pollUrl) throw new AppError('Alexya : pas de poll_url pour la génération vidéo', 502);

  return pollVideoGeneration(pollUrl);
}

/** Coût Alexya réel (en crédits internes Alexya) pour info/monitoring, pas facturé au client tel quel. */
export function estimateAlexyaCreditsForClip(mode: 'best' | 'cinematic', duration: number, soundEnabled: boolean): number {
  if (mode === 'best') return duration * 28;
  return soundEnabled ? Math.ceil(duration * 63) : Math.ceil(duration * 40); // cinematic sans son : tarif intermédiaire, à revérifier au dashboard
}
