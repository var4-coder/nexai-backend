import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { NETLIFY_APEX_IP } from '@/services/godaddy.service';

const PORKBUN_API = 'https://api.porkbun.com/api/json/v3';

type PorkbunJson = Record<string, unknown>;

function configured(): boolean {
  return Boolean(env.PORKBUN_API_KEY && env.PORKBUN_SECRET_API_KEY);
}

async function porkbunFetch(path: string, body: PorkbunJson = {}): Promise<PorkbunJson> {
  if (!configured()) {
    throw new AppError('Porkbun non configuré', 503);
  }
  const res = await fetch(`${PORKBUN_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.PORKBUN_API_KEY,
      'X-Secret-API-Key': env.PORKBUN_SECRET_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as PorkbunJson;
  const status = String(data.status || '');
  if (!res.ok || (status && status !== 'SUCCESS')) {
    const message = String(data.message || data.code || `Porkbun ${res.status}`);
    throw new AppError(`Porkbun : ${message}`, 502);
  }
  return data;
}

function prixUsd(valeur: unknown): number | null {
  const n = typeof valeur === 'number' ? valeur : Number(valeur);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Vérifie un nom chez Porkbun.
 * Le prix de check est en dollars (chaîne "9.73"). L'achat, lui, exige des centimes.
 */
export async function checkPorkbunAvailability(
  domain: string
): Promise<{ available: boolean; priceUsd: number | null; renewalUsd: number | null; costPennies: number | null }> {
  const data = await porkbunFetch(`/domain/checkDomain/${encodeURIComponent(domain)}`);
  const response = (data.response || {}) as PorkbunJson;
  const available = String(response.avail || '') === 'yes';
  const price = prixUsd(response.price);
  const additional = (response.additional || {}) as PorkbunJson;
  const renewal = (additional.renewal || {}) as PorkbunJson;
  const renewalUsd = prixUsd(renewal.price);
  return {
    available,
    priceUsd: price,
    renewalUsd,
    costPennies: price === null ? null : Math.round(price * 100),
  };
}

/** Achète le nom sur le solde Porkbun, puis coupe le renouvellement automatique. */
export async function purchasePorkbunDomain(domain: string): Promise<void> {
  const check = await checkPorkbunAvailability(domain);
  if (!check.available || check.costPennies === null) {
    throw new AppError(`Domaine ${domain} indisponible chez Porkbun`, 409);
  }
  await porkbunFetch(`/domain/create/${encodeURIComponent(domain)}`, {
    cost: check.costPennies,
    agreeToTerms: 'yes',
    whoisPrivacy: true,
  });
  await porkbunFetch(`/domain/updateAutoRenew/${encodeURIComponent(domain)}`, { status: 'no' }).catch(() => undefined);
}

export async function renewPorkbunDomain(domain: string): Promise<void> {
  const data = await porkbunFetch(`/domain/checkDomain/${encodeURIComponent(domain)}`, { priceType: 'renewal' });
  const response = (data.response || {}) as PorkbunJson;
  const additional = (response.additional || {}) as PorkbunJson;
  const renewal = (additional.renewal || {}) as PorkbunJson;
  const price = prixUsd(renewal.price) ?? prixUsd(response.price);
  if (price === null) throw new AppError('Prix de renouvellement Porkbun indisponible', 502);
  await porkbunFetch(`/domain/renew/${encodeURIComponent(domain)}`, {
    cost: Math.round(price * 100),
    agreeToTerms: 'yes',
  });
}

export async function getPorkbunDomainDetails(domain: string): Promise<{ expires?: string }> {
  const data = await porkbunFetch('/domain/listAll');
  const domains = Array.isArray(data.domains) ? data.domains : [];
  const found = domains.find((d) => String((d as PorkbunJson).domain || '').toLowerCase() === domain.toLowerCase()) as
    | PorkbunJson
    | undefined;
  const expires = found?.expireDate || found?.expires || found?.expirationDate;
  return { expires: expires ? String(expires) : undefined };
}

async function createRecord(domain: string, type: string, name: string, content: string): Promise<void> {
  await porkbunFetch(`/dns/create/${encodeURIComponent(domain)}`, {
    name,
    type,
    content,
    ttl: 600,
  });
}

/** Pose l'adresse Netlify : A sur la racine, CNAME sur www. */
export async function addPorkbunNetlifyDns(domain: string, netlifyHost: string): Promise<void> {
  const host = netlifyHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
  await createRecord(domain, 'A', '', NETLIFY_APEX_IP);
  await createRecord(domain, 'CNAME', 'www', host);
}
