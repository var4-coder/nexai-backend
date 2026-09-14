import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

const GODADDY_API = 'https://api.godaddy.com/v1';

async function godaddyFetch<T = unknown>(path: string, init?: RequestInit): Promise<T | null> {
  if (!env.GODADDY_API_KEY || !env.GODADDY_API_SECRET) {
    throw new AppError('GoDaddy non configuré', 503);
  }
  const res = await fetch(`${GODADDY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `sso-key ${env.GODADDY_API_KEY}:${env.GODADDY_API_SECRET}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`GoDaddy API error ${res.status}: ${body}`, 502);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

/**
 * Vérifie la disponibilité ET le prix réel d'un domaine (checkType=FULL —
 * l'API GoDaddy ne renvoie le prix qu'avec ce mode, plus lent que FAST mais
 * nécessaire : le prix crédits facturé au client doit refléter le tarif
 * GoDaddy exact, voir credits.service.ts getDomainPriceCredits).
 * `price` est en micro-unités de la devise (ex. 12990000 = $12.99) — voir
 * la doc GoDaddy /domains/available.
 */
export async function checkDomainAvailability(
  domain: string
): Promise<{ available: boolean; priceUsd: number | null }> {
  const data = await godaddyFetch<{ available?: boolean; price?: number; currency?: string }>(
    `/domains/available?domain=${encodeURIComponent(domain)}&checkType=FULL`
  );
  const available = Boolean(data?.available);
  // price est en micro-unités (ex. 12990000 = 12.99 USD). Si la devise
  // renvoyée n'est pas USD, on ne peut pas convertir fiablement ici — on
  // renvoie null plutôt qu'un chiffre faux (le caller retombe alors sur un
  // message d'erreur explicite plutôt qu'un prix silencieusement incorrect).
  const priceUsd =
    available && typeof data?.price === 'number' && (!data?.currency || data.currency === 'USD')
      ? data.price / 1_000_000
      : null;
  return { available, priceUsd };
}

/**
 * Achète un domaine via le compte GoDaddy NexAI (Architecture A.13).
 * Attention : nécessite un compte configuré + consentements de facturation.
 */
export async function purchaseDomain(domain: string, years = 1): Promise<void> {
  await godaddyFetch('/domains/purchase', {
    method: 'POST',
    body: JSON.stringify({
      domain,
      period: years,
      renewAuto: true,
      privacy: true,
    }),
  });
}

/**
 * Ajoute un enregistrement DNS ciblé pointant vers Netlify
 * (sans déléguer les nameservers complets — Architecture A.13).
 */
export async function addNetlifyDnsRecord(domain: string, netlifyTarget: string): Promise<void> {
  // Pour un domaine apex on utilise souvent un ALIAS / A ; pour un sous-domaine un CNAME.
  // Ici on pose un CNAME générique vers le target Netlify fourni.
  await godaddyFetch(`/domains/${domain}/records`, {
    method: 'PUT',
    body: JSON.stringify([
      {
        type: 'CNAME',
        name: '@',
        data: netlifyTarget.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        ttl: 600,
      },
    ]),
  });
}
