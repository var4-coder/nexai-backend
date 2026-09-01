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
 * Vérifie la disponibilité d'un domaine.
 */
export async function checkDomainAvailability(domain: string): Promise<boolean> {
  const data = await godaddyFetch<{ available?: boolean }>(
    `/domains/available?domain=${encodeURIComponent(domain)}`
  );
  return Boolean(data?.available);
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
