import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { Agent, setGlobalDispatcher } from 'undici';
import { enregistrerUsage } from '@/services/depense-context';

/**
 * Le `fetch` natif de Node.js repose en interne sur `undici`, qui applique
 * ses PROPRES timeouts par défaut (headersTimeout / bodyTimeout ≈ 5 min),
 * complètement indépendants de l'AbortController utilisé ci-dessous. Sans
 * ceci, Node coupe la requête lui-même avec `UND_ERR_HEADERS_TIMEOUT` avant
 * même que notre timeout (calculé plus haut, jusqu'à ~8 min pour une
 * génération de page complète) n'ait eu la moindre chance de s'appliquer.
 * On aligne cette limite Node sur la plus grande valeur possible calculée
 * par `resolveTimeoutMs` (voir plus bas), avec une marge de sécurité.
 * Appliqué une seule fois au chargement de ce module, pour l'API comme
 * pour le worker (tous deux importent ce fichier).
 */
setGlobalDispatcher(
  new Agent({
    headersTimeout: 600_000, // 10 min
    bodyTimeout: 600_000,
    connectTimeout: 30_000,
  })
);

/**
 * Clients API réels — xAI (Grok) + Anthropic (Claude).
 * Timeout + retries UNIQUEMENT sur erreurs transitoires (réseau / 429 / 5xx).
 */

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Usage du DERNIER appel IA effectué, publié pour le compteur de coût.
 *
 * Le pipeline le lit juste après chaque appel. Une variable de module
 * suffit : le worker traite ses jobs l'un après l'autre à l'intérieur d'un
 * même flux, et la lecture suit immédiatement l'appel.
 */
export let dernierUsage: { modele: string; entree: number; sortie: number } | null = null;

/** Remet le compteur à zéro avant une série d'appels. */
export function reinitialiserUsage(): void {
  dernierUsage = null;
}
/**
 * Tentatives sur le MÊME modèle.
 *
 * Les petits appels (juges, titres) durent quelques secondes : réessayer y a
 * du sens. Les grosses générations, elles, ne sont PAS réessayées sur le
 * même modèle — un fournisseur lent le restera, et le pipeline bascule sur
 * l'autre famille, ce qui est à la fois plus rapide et plus fiable.
 */
const MAX_RETRIES = 2;
const MAX_RETRIES_GROSSE_GENERATION = 0;
// 8 000 tokens et au-delà : une seule tentative. En dessous, les appels
// durent quelques secondes et trois tentatives restent rapides.
const SEUIL_GROSSE_GENERATION_TOKENS = 8_000;

/** Tentatives autorisées pour un appel, selon sa taille. */
function retriesPour(opts?: { maxTokens?: number }): number {
  return (opts?.maxTokens ?? 0) >= SEUIL_GROSSE_GENERATION_TOKENS
    ? MAX_RETRIES_GROSSE_GENERATION
    : MAX_RETRIES;
}
const RETRY_BASE_MS = 800;

/**
 * Calcule un timeout proportionnel à la taille de génération demandée.
 *
 * 90s fixes suffisaient pour de petites réponses (titres, JSON de jugement)
 * mais sont bien trop courts pour une génération de page complète
 * (maxTokens: 16000) : au débit de sortie constaté des modèles actuels
 * (~50-60 tokens/s) plus le délai avant le premier token (30-40s), une
 * réponse de 16 000 tokens peut prendre 4-5 minutes. Sans ce calcul, ces
 * appels étaient annulés (AbortError) avant la fin de la génération, à
 * chacune des tentatives — d'où des échecs systématiques de génération de
 * site qui n'ont rien à voir avec une panne du fournisseur.
 *
 * `timeoutMs` explicite dans les options reste toujours prioritaire.
 */
function resolveTimeoutMs(opts?: { maxTokens?: number; timeoutMs?: number }): number {
  if (opts?.timeoutMs) return opts.timeoutMs;
  const maxTokens = opts?.maxTokens ?? 8000;
  // Le délai doit laisser l'IA FINIR son travail.
  //
  // Les modèles produisent 40 à 55 tokens/seconde, après 30 à 40 s avant le
  // premier token. Une page de 16 000 tokens demande donc 5,5 à 7,3 min.
  // Un plafond plus serré couperait une génération qui se déroule bien —
  // c'est exactement le bug qui faisait échouer toutes les générations.
  //
  // Le plancher est abaissé pour les petits appels : un juge qui rend
  // quelques lignes de JSON n'a aucune raison d'attendre plusieurs minutes.
  const plancher = maxTokens <= 2_000 ? 45_000 : DEFAULT_TIMEOUT_MS;
  return Math.max(plancher, 45_000 + maxTokens * 25);
}

/** Erreurs où un nouvel essai a une chance de réussir (réseau / 429 / 5xx). */
export function isRetryableApiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    message?: string;
    statusCode?: number;
    cause?: { code?: string; message?: string };
  };
  const msg = `${e.message || ''} ${e.cause?.message || ''} ${e.cause?.code || ''}`.toLowerCase();
  const status = e.statusCode;

  if (status === 401 || status === 403 || status === 400) return false;
  if (
    msg.includes('api_key manquante') ||
    msg.includes('invalid_api_key') ||
    msg.includes('configuration ia') ||
    msg.includes('brief incomplet') ||
    msg.includes('accès refusé')
  ) {
    return false;
  }

  return (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes('fetch failed') ||
    msg.includes('indisponible après') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('socket') ||
    msg.includes('und_err') ||
    msg.includes('timeout') ||
    /\b429\b/.test(msg) ||
    /\b502\b/.test(msg) ||
    /\b503\b/.test(msg) ||
    /\b504\b/.test(msg)
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exportée pour être réutilisée par les services qui appellent l'API xAI en
 * dehors des fonctions ci-dessous (ex. grok-imagine.service.ts) — évite de
 * dupliquer la logique de timeout/retry, et donc de recréer les mêmes bugs.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /**
   * Tentatives autorisées. Les grosses générations n'en ont qu'une : le
   * pipeline bascule ensuite sur l'autre famille de modèles plutôt que de
   * réessayer un fournisseur déjà trop lent.
   */
  maxRetries = MAX_RETRIES
): Promise<Response> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const debutAppel = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok && isRetryableStatus(res.status) && attempt < maxRetries) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `[ai-clients] ${label} HTTP ${res.status} — retry ${attempt + 1}/${maxRetries} dans ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (isRetryableApiError(err) && attempt < maxRetries) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        // La CAUSE est journalisée : « réseau » seul ne permettait pas de
        // distinguer un délai dépassé (AbortError) d'une vraie coupure
        // (fetch failed), ni de savoir combien de temps l'appel a duré.
        const e = err as { name?: string; message?: string; cause?: { code?: string } };
        const cause = e?.cause?.code || e?.name || 'inconnue';
        const duree = Math.round((Date.now() - debutAppel) / 1000);
        console.warn(
          `[ai-clients] ${label} échec (${cause} : ${String(e?.message).slice(0, 120)}) ` +
            `après ${duree}s — retry ${attempt + 1}/${maxRetries} dans ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      break;
    }
  }

  const detail =
    lastErr instanceof Error
      ? `${lastErr.name}: ${lastErr.message}${lastErr.cause ? ` | cause: ${JSON.stringify(lastErr.cause)}` : ''}`
      : String(lastErr);
  throw new AppError(`${label} indisponible après ${MAX_RETRIES + 1} tentatives — ${detail}`, 502);
}

/** À appeler AVANT tout débit de crédits. */
export function assertAiKeysConfigured(): void {
  const missing: string[] = [];
  if (!env.XAI_API_KEY) missing.push('XAI_API_KEY');
  if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    throw new AppError(
      `Configuration IA incomplète (${missing.join(', ')} manquante) — impossible de générer.`,
      503
    );
  }
}

// ─── xAI Grok ─────────────────────────────────────────────

const XAI_BASE = 'https://api.x.ai/v1';

export type GrokModel = 'grok-4.7' | 'grok-4.6' | 'grok-4.5' | 'grok-4.3' | 'grok-build-0.1';

export async function callGrok(
  model: GrokModel,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number }
): Promise<string> {
  if (!env.XAI_API_KEY) {
    throw new AppError('XAI_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const res = await fetchWithRetry(
    `${XAI_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts?.maxTokens ?? 16000,
        temperature: opts?.temperature ?? 0.4,
      }),
    },
    `xAI/${model}`,
    resolveTimeoutMs(opts),
    retriesPour(opts)
  );

  if (!res.ok) {
    const body = await res.text();
    const err = new AppError(`xAI API error ${res.status}: ${body.slice(0, 400)}`, 502);
    (err as AppError & { statusCode: number }).statusCode = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  // Tokens RÉELLEMENT consommés, tels que le fournisseur les facture.
  // Publiés pour le compteur de coût, qui ne repose ainsi sur aucune
  // estimation.
  dernierUsage = {
    modele: model,
    entree: data.usage?.prompt_tokens ?? 0,
    sortie: data.usage?.completion_tokens ?? 0,
  };
  enregistrerUsage(dernierUsage.modele, dernierUsage.entree, dernierUsage.sortie);
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new AppError('Réponse xAI vide ou invalide', 502);
  }
  return content;
}

// ─── Anthropic Claude ─────────────────────────────────────

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export type ClaudeModel =
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'claude-haiku-4-5-20251001'
  /** Agent qualité : diagnostic des prompts, alertes payantes, réparations complexes */
  | 'claude-fable-5-1';

export async function callClaude(
  model: ClaudeModel,
  system: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number }
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const res = await fetchWithRetry(
    `${ANTHROPIC_BASE}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // NOTE : Anthropic a déprécié le paramètre `temperature` pour ses
      // modèles récents (Sonnet 5, Opus 4.8, Fable/Mythos 5...) — l'envoyer,
      // même avec une valeur, fait échouer la requête en 400
      // ("`temperature` is deprecated for this model"). Comme ce rôle peut
      // être basculé vers n'importe quel modèle depuis l'admin, on ne
      // l'envoie plus du tout : c'est sans risque (paramètre optionnel) et
      // ça marche avec tous les modèles, anciens et récents.
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? 8000,
        system,
        messages,
      }),
    },
    `Anthropic/${model}`,
    resolveTimeoutMs(opts),
    retriesPour(opts)
  );

  if (!res.ok) {
    const body = await res.text();
    const err = new AppError(`Anthropic API error ${res.status}: ${body.slice(0, 400)}`, 502);
    (err as AppError & { statusCode: number }).statusCode = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  dernierUsage = {
    modele: model,
    entree: data.usage?.input_tokens ?? 0,
    sortie: data.usage?.output_tokens ?? 0,
  };
  enregistrerUsage(dernierUsage.modele, dernierUsage.entree, dernierUsage.sortie);
  const textBlock = data.content?.find((b) => b.type === 'text');
  const content = textBlock?.text;
  if (!content || typeof content !== 'string') {
    throw new AppError('Réponse Anthropic vide ou invalide', 502);
  }
  return content;
}

/**
 * Variante multimodale : envoie des images (par URL) à Claude pour un jugement
 * visuel réel — utilisé pour la sélection d'images mockup.
 */
export async function callClaudeVision(
  model: ClaudeModel,
  system: string,
  prompt: string,
  imageUrls: string[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number }
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const content = [
    ...imageUrls.map((url) => ({ type: 'image' as const, source: { type: 'url' as const, url } })),
    { type: 'text' as const, text: prompt },
  ];

  const res = await fetchWithRetry(
    `${ANTHROPIC_BASE}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // Voir la note dans callClaude ci-dessus : `temperature` est déprécié
      // et rejeté (400) par les modèles Anthropic récents, donc on ne
      // l'envoie plus.
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? 200,
        system,
        messages: [{ role: 'user', content }],
      }),
    },
    `AnthropicVision/${model}`,
    resolveTimeoutMs(opts),
    retriesPour(opts)
  );

  if (!res.ok) {
    const body = await res.text();
    const err = new AppError(`Anthropic Vision API error ${res.status}: ${body.slice(0, 400)}`, 502);
    (err as AppError & { statusCode: number }).statusCode = res.status;
    throw err;
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  const text = textBlock?.text;
  if (!text || typeof text !== 'string') {
    throw new AppError('Réponse Anthropic Vision vide ou invalide', 502);
  }
  return text;
}

/**
 * Appel Claude avec images transmises en BASE64.
 *
 * Nécessaire pour le juge visuel : au moment du jugement, le site n'est pas
 * encore en ligne et n'a donc pas d'URL. Les captures sont produites en
 * mémoire et envoyées directement, sans passer par un stockage — aucun coût
 * de fichier, aucune trace laissée.
 */
export async function callClaudeVisionBase64(
  model: ClaudeModel,
  system: string,
  prompt: string,
  images: { base64: string; mediaType: 'image/png' | 'image/jpeg' }[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number }
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const content = [
    ...images.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
    })),
    { type: 'text' as const, text: prompt },
  ];

  const res = await fetchWithRetry(
    `${ANTHROPIC_BASE}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      // Voir la note dans callClaude : `temperature` est déprécié et rejeté
      // (400) par les modèles Anthropic récents, donc on ne l'envoie plus.
      body: JSON.stringify({
        model,
        max_tokens: opts?.maxTokens ?? 1200,
        system,
        messages: [{ role: 'user', content }],
      }),
    },
    `AnthropicVision/${model}`,
    resolveTimeoutMs(opts),
    retriesPour(opts)
  );

  if (!res.ok) {
    const body = await res.text();
    const err = new AppError(`Anthropic Vision API error ${res.status}: ${body.slice(0, 400)}`, 502);
    (err as AppError & { statusCode: number }).statusCode = res.status;
    throw err;
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text;
  if (!text || typeof text !== 'string') {
    throw new AppError('Réponse Anthropic Vision vide ou invalide', 502);
  }
  return text;
}
