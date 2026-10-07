import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { fetchWithRetry } from '@/services/ai-clients';
import type { IPrixModele } from '@/models/AtelierSkills';

/**
 * Appels aux quatre éditeurs de l'Atelier Skills (avenant v1.3 §13, point 2) :
 * Anthropic, xAI (Grok, avec recherche web + X pour le documentaliste),
 * OpenAI et DeepSeek. Chaque appel renvoie son texte ET ses jetons réels :
 * le coût est calculé par appel (jamais via une variable partagée, les
 * appels d'une étape tournent en parallèle).
 *
 * Confidentialité (cahier v1 §9.5) : aucun contenu d'échange n'est écrit
 * dans les journaux, seulement les métadonnées.
 */

export interface ResultatAppel {
  texte: string;
  entree: number;
  sortie: number;
  cache: number;
}

export interface OptionsAppel {
  modele: string;
  systeme: string;
  message: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'defaut';
  /** Sortie JSON demandée (mode JSON du fournisseur quand il existe). */
  json?: boolean;
  /** Documentaliste : recherche web et X (Grok, API Responses). */
  recherche?: boolean;
  timeoutMs?: number;
}

function effortValide(e?: OptionsAppel['effort']): 'low' | 'medium' | 'high' | undefined {
  return e && e !== 'defaut' ? e : undefined;
}

async function lireErreur(res: Response, fournisseur: string): Promise<never> {
  const corps = (await res.text()).slice(0, 300);
  const err = new AppError(`${fournisseur} : erreur ${res.status} — ${corps}`, 502);
  (err as AppError & { statusCode: number }).statusCode = res.status;
  throw err;
}

async function appelAnthropic(o: OptionsAppel): Promise<ResultatAppel> {
  if (!env.ANTHROPIC_API_KEY) throw new AppError('ANTHROPIC_API_KEY manquante', 503);
  const effort = effortValide(o.effort);
  const res = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.modele,
        max_tokens: o.maxTokens,
        // Consigne système mise en cache (cache_control), comme pour la génération de sites.
        system: [{ type: 'text', text: o.systeme, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: o.message }],
        ...(effort ? { output_config: { effort } } : {}),
      }),
    },
    `Atelier/${o.modele}`,
    o.timeoutMs ?? 300_000,
    1
  );
  if (!res.ok) await lireErreur(res, 'Anthropic');
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  const texte = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return {
    texte,
    // Écriture en cache facturée 1,25 × l'entrée (5 minutes) : comptée comme telle.
    entree: (data.usage?.input_tokens ?? 0) + Math.round((data.usage?.cache_creation_input_tokens ?? 0) * 1.25),
    sortie: data.usage?.output_tokens ?? 0,
    cache: data.usage?.cache_read_input_tokens ?? 0,
  };
}

/** Texte d'une réponse au format « Responses » (OpenAI et xAI). */
function texteResponses(data: { output_text?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[] }): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  return (data.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

async function appelOpenAI(o: OptionsAppel): Promise<ResultatAppel> {
  if (!env.OPENAI_API_KEY) throw new AppError('OPENAI_API_KEY manquante (Render → Environment)', 503);
  const effort = effortValide(o.effort);
  const res = await fetchWithRetry(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.modele,
        instructions: o.systeme,
        input: [{ role: 'user', content: o.message }],
        max_output_tokens: o.maxTokens,
        ...(effort ? { reasoning: { effort } } : {}),
        ...(o.json ? { text: { format: { type: 'json_object' } } } : {}),
      }),
    },
    `Atelier/${o.modele}`,
    o.timeoutMs ?? 300_000,
    1
  );
  if (!res.ok) await lireErreur(res, 'OpenAI');
  const data = (await res.json()) as Parameters<typeof texteResponses>[0] & {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  const cache = data.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    texte: texteResponses(data),
    entree: Math.max(0, (data.usage?.input_tokens ?? 0) - cache),
    sortie: data.usage?.output_tokens ?? 0,
    cache,
  };
}

async function appelDeepSeek(o: OptionsAppel): Promise<ResultatAppel> {
  if (!env.DEEPSEEK_API_KEY) throw new AppError('DEEPSEEK_API_KEY manquante (Render → Environment)', 503);
  const res = await fetchWithRetry(
    'https://api.deepseek.com/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.modele,
        messages: [
          { role: 'system', content: o.systeme },
          { role: 'user', content: o.message },
        ],
        max_tokens: o.maxTokens,
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    },
    `Atelier/${o.modele}`,
    o.timeoutMs ?? 180_000,
    1
  );
  if (!res.ok) await lireErreur(res, 'DeepSeek');
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  const cache = data.usage?.prompt_cache_hit_tokens ?? 0;
  return {
    texte: data.choices?.[0]?.message?.content ?? '',
    entree: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cache),
    sortie: data.usage?.completion_tokens ?? 0,
    cache,
  };
}

async function appelGrok(o: OptionsAppel): Promise<ResultatAppel> {
  if (!env.XAI_API_KEY) throw new AppError('XAI_API_KEY manquante', 503);
  if (o.recherche) {
    // Documentaliste : API Responses de xAI avec les outils web_search et
    // x_search (l'ancien paramètre search_parameters a été supprimé). La
    // recherche X est lente : délai d'attente d'au moins 120 s (cahier v1 §11).
    const res = await fetchWithRetry(
      'https://api.x.ai/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: o.modele,
          input: [
            { role: 'system', content: o.systeme },
            { role: 'user', content: o.message },
          ],
          tools: [{ type: 'web_search' }, { type: 'x_search' }],
          max_output_tokens: o.maxTokens,
        }),
      },
      `Atelier/${o.modele}/recherche`,
      Math.max(o.timeoutMs ?? 0, 300_000),
      1
    );
    if (!res.ok) await lireErreur(res, 'xAI');
    const data = (await res.json()) as Parameters<typeof texteResponses>[0] & {
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    };
    const cache = data.usage?.input_tokens_details?.cached_tokens ?? 0;
    return {
      texte: texteResponses(data),
      entree: Math.max(0, (data.usage?.input_tokens ?? 0) - cache),
      sortie: data.usage?.output_tokens ?? 0,
      cache,
    };
  }
  const res = await fetchWithRetry(
    'https://api.x.ai/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.modele,
        messages: [
          { role: 'system', content: o.systeme },
          { role: 'user', content: o.message },
        ],
        max_tokens: o.maxTokens,
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    },
    `Atelier/${o.modele}`,
    o.timeoutMs ?? 240_000,
    1
  );
  if (!res.ok) await lireErreur(res, 'xAI');
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const cache = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    texte: data.choices?.[0]?.message?.content ?? '',
    entree: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cache),
    sortie: data.usage?.completion_tokens ?? 0,
    cache,
  };
}

/**
 * Simulateur pour les tests automatiques uniquement (aucune route ne l'active) :
 * permet de dérouler tout le pipeline sans appeler les fournisseurs.
 */
let simulateur: ((o: OptionsAppel) => Promise<ResultatAppel>) | null = null;
export function definirSimulateurPourTests(f: typeof simulateur): void {
  simulateur = f;
}

export async function appelerModeleBrut(o: OptionsAppel): Promise<ResultatAppel> {
  if (simulateur) return simulateur(o);
  if (o.modele.startsWith('claude-')) return appelAnthropic(o);
  if (o.modele.startsWith('grok-')) return appelGrok(o);
  if (o.modele.startsWith('gpt-')) return appelOpenAI(o);
  if (o.modele.startsWith('deepseek-')) return appelDeepSeek(o);
  throw new AppError(`Fournisseur inconnu pour le modèle ${o.modele}`, 400);
}

export function coutAppel(prix: IPrixModele | undefined, r: Pick<ResultatAppel, 'entree' | 'sortie' | 'cache'>): number {
  if (!prix) return 0;
  return (r.entree * prix.entree + r.sortie * prix.sortie + r.cache * prix.cache) / 1e6;
}

/** Extrait l'objet JSON d'une réponse (tolère des balises de code ou une phrase autour). */
export function extraireJson(texte: string): unknown {
  const nettoye = texte.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(nettoye);
  } catch {
    const debut = nettoye.indexOf('{');
    const fin = nettoye.lastIndexOf('}');
    if (debut >= 0 && fin > debut) return JSON.parse(nettoye.slice(debut, fin + 1));
    throw new Error('Réponse sans JSON exploitable');
  }
}
