import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

const NETLIFY_API = 'https://api.netlify.com/api/v1';

async function netlifyFetch(path: string, init?: RequestInit) {
  if (!env.NETLIFY_ACCESS_TOKEN) {
    throw new AppError('Netlify non configuré', 503);
  }
  const res = await fetch(`${NETLIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NETLIFY_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`Netlify API error ${res.status}: ${body}`, 502);
  }
  return res.json();
}

/**
 * Crée un site Netlify pour un client (un site = un déploiement).
 * Architecture A.13 / §10.
 */
export async function createNetlifySite(name: string): Promise<{ id: string; url: string; ssl_url: string }> {
  // Le nom d'un site Netlify est unique au monde : si « nexai-xxx » est déjà
  // pris (422), on retente avec un suffixe aléatoire plutôt que d'échouer.
  let essai = name;
  for (let tentative = 0; ; tentative++) {
    try {
      const data = (await netlifyFetch('/sites', {
        method: 'POST',
        body: JSON.stringify({ name: essai, force_ssl: true }),
      })) as { id: string; url: string; ssl_url: string };
      return { id: data.id, url: data.url, ssl_url: data.ssl_url };
    } catch (err) {
      const nomPris = err instanceof AppError && /\b422\b/.test(err.message);
      if (!nomPris || tentative >= 3) throw err;
      const suffixe = Math.random().toString(36).slice(2, 6);
      essai = `${name.slice(0, 55)}-${suffixe}`;
    }
  }
}

/** Adresse réelle du site chez Netlify (ex. « nexai-monsite-a1b2.netlify.app »), jamais reconstituée à la main. */
export async function getNetlifyHost(siteId: string): Promise<string> {
  const data = (await netlifyFetch(`/sites/${siteId}`)) as { default_domain?: string; url?: string; ssl_url?: string };
  const host = data.default_domain || (data.ssl_url || data.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!host) throw new AppError('Adresse Netlify du site introuvable', 502);
  return host;
}

/**
 * Déploie un site statique (fichiers HTML/CSS/JS production).
 * En pratique on utilise l'API de deploy avec un zip ou des fichiers.
 * Ici : helper qui prépare l'appel ; le zip est généré en amont par le pipeline.
 */
export async function deploySite(siteId: string, zipBuffer: Buffer): Promise<{ deployId: string; url: string }> {
  if (!env.NETLIFY_ACCESS_TOKEN) throw new AppError('Netlify non configuré', 503);

  const res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NETLIFY_ACCESS_TOKEN}`,
      'Content-Type': 'application/zip',
    },
    body: zipBuffer,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`Netlify deploy error ${res.status}: ${body}`, 502);
  }

  const data = (await res.json()) as { id: string; ssl_url?: string; url?: string };
  return { deployId: data.id, url: data.ssl_url || data.url || '' };
}

/**
 * Attache un domaine personnalisé (GoDaddy ou BYOD) au site Netlify.
 * Déclenche la génération SSL automatique.
 */
/** Vrai pour « monsite.com » ou « monsite.co.uk » ; faux pour « boutique.monsite.com » ou « www.monsite.com ». */
export function estDomaineRacine(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  if (labels.length === 2) return true;
  const secondNiveau = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  return labels.length === 3 && labels[2].length === 2 && secondNiveau.has(labels[1]);
}

export async function attachDomain(
  siteId: string,
  domain: string,
  /**
   * Sous-domaine NexAI à conserver en alias permanent.
   *
   * Sans lui, attacher un domaine personnalisé REMPLACE l'adresse NexAI : si
   * le domaine expire ensuite, le site ne garde que son adresse technique
   * `xxx.netlify.app`, que le client n'a jamais communiquée à personne. Avec
   * l'alias, le site reste joignable sur son adresse NexAI en toutes
   * circonstances.
   */
  subdomainAlias?: string
): Promise<void> {
  const aliases = subdomainAlias
    ? [`${subdomainAlias}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`]
    : [];
  // Domaine racine : « www » est servi aussi (le CNAME www est posé en DNS).
  if (estDomaineRacine(domain)) aliases.push(`www.${domain}`);
  await netlifyFetch(`/sites/${siteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ custom_domain: domain, domain_aliases: aliases }),
  });
}

/**
 * Repli sur le sous-domaine NexAI, par exemple quand un domaine personnalisé
 * expire faute de renouvellement. Le site ne devient jamais inaccessible : il
 * retrouve son adresse NexAI, qui redevient l'adresse principale.
 */
export async function revertToSubdomain(siteId: string, subdomain: string): Promise<void> {
  await netlifyFetch(`/sites/${siteId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      custom_domain: `${subdomain}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`,
      domain_aliases: [],
    }),
  });
}

/**
 * Sous-domaine gratuit NexAI : le domaine de base est délégué en DNS chez
 * Netlify (wildcard SSL). Le domaine de base est configurable
 * (NEXAI_SUBDOMAIN_BASE_DOMAIN) pour respecter exactement celui sur lequel
 * le wildcard DNS a réellement été configuré côté Netlify — ne jamais
 * remettre une valeur en dur ici.
 */
export async function attachSubdomain(siteId: string, subdomain: string): Promise<void> {
  await netlifyFetch(`/sites/${siteId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      custom_domain: `${subdomain}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}`,
    }),
  });
}

/**
 * Retire définitivement un site de l'hébergeur.
 *
 * Appelé quand le client supprime son site. Sans cela, le site resterait en
 * ligne et visible alors que le client le croit supprimé — et continuerait
 * de consommer de la bande passante facturée.
 */
export async function deleteNetlifySite(siteId: string): Promise<void> {
  await netlifyFetch(`/sites/${siteId}`, { method: 'DELETE' });
}
