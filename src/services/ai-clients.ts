import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Clients API réels — xAI (Grok) + Anthropic (Claude).
 * Aucun mock. Les clés viennent uniquement des variables d'environnement (Render / .env).
 */

// ─── xAI Grok ─────────────────────────────────────────────

const XAI_BASE = 'https://api.x.ai/v1';

export type GrokModel = 'grok-4.6' | 'grok-4.5' | 'grok-build-0.1';

export async function callGrok(
  model: GrokModel,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  if (!env.XAI_API_KEY) {
    throw new AppError('XAI_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const res = await fetch(`${XAI_BASE}/chat/completions`, {
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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`xAI API error ${res.status}: ${body.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new AppError('Réponse xAI vide ou invalide', 502);
  }
  return content;
}

// ─── Anthropic Claude ─────────────────────────────────────

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export type ClaudeModel = 'claude-sonnet-5' | 'claude-opus-5' | 'claude-haiku-4-5-20251001';

export async function callClaude(
  model: ClaudeModel,
  system: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts?.maxTokens ?? 8000,
      temperature: opts?.temperature ?? 0.3,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`Anthropic API error ${res.status}: ${body.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  const content = textBlock?.text;
  if (!content || typeof content !== 'string') {
    throw new AppError('Réponse Anthropic vide ou invalide', 502);
  }
  return content;
}

/**
 * Variante multimodale : envoie des images (par URL) à Claude pour un jugement
 * visuel réel — utilisé pour la sélection d'images mockup (voir
 * site-image-sourcing.service.ts). Séparée de callClaude() pour ne pas
 * complexifier l'appel texte-only utilisé partout ailleurs dans le pipeline.
 */
export async function callClaudeVision(
  model: ClaudeModel,
  system: string,
  prompt: string,
  imageUrls: string[],
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY manquante — configure-la sur Render (Environment)', 503);
  }

  const content = [
    ...imageUrls.map((url) => ({ type: 'image', source: { type: 'url', url } })),
    { type: 'text', text: prompt },
  ];

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts?.maxTokens ?? 200,
      temperature: opts?.temperature ?? 0,
      system,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`Anthropic Vision API error ${res.status}: ${body.slice(0, 400)}`, 502);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  const text = textBlock?.text;
  if (!text || typeof text !== 'string') {
    throw new AppError('Réponse Anthropic Vision vide ou invalide', 502);
  }
  return text;
}
