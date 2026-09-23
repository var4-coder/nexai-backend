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
 * Renouvelle un domaine déjà détenu dans le compte GoDaddy de NexAI.
 *
 * Appelé uniquement une fois la provision du client intégralement constituée
 * (voir domain-renewal.service.ts) : NexAI ne débourse jamais avant d'avoir
 * encaissé. C'est le pendant indispensable de `renewAuto: false` sur l'achat —
 * sans cet appel, aucun domaine ne serait jamais renouvelé.
 */
export async function renewDomain(domain: string, years = 1): Promise<void> {
  await godaddyFetch(`/domains/${encodeURIComponent(domain)}/renew`, {
    method: 'POST',
    body: JSON.stringify({ period: years }),
  });
}

/**
 * État d'un domaine détenu par NexAI : sert à recaler l'échéance réelle après
 * un renouvellement plutôt que de la supposer.
 */
export async function getDomainDetails(
  domain: string
): Promise<{ expires: string | null; renewable: boolean; status: string | null }> {
  const data = await godaddyFetch<{
    expires?: string;
    renewable?: boolean;
    status?: string;
  }>(`/domains/${encodeURIComponent(domain)}`);
  return {
    expires: data?.expires ?? null,
    renewable: Boolean(data?.renewable),
    status: data?.status ?? null,
  };
}

/**
 * Récupère dynamiquement les clés d'accords légaux exigées par GoDaddy pour
 * le TLD concerné (ex. "DNRA" pour la plupart des .com/.net, mais certains
 * TLD — ccTLD notamment — exigent des accords supplémentaires). On ne
 * hardcode donc jamais "DNRA" seul : un achat pourrait être rejeté par
 * GoDaddy sur un TLD qui demande un accord de plus.
 */
async function fetchRequiredAgreementKeys(tld: string): Promise<string[]> {
  const data = await godaddyFetch<Array<{ agreementKey: string }>>(
    `/domains/agreements?tlds=${encodeURIComponent(tld)}&privacy=true&forTransfer=false`
  );
  const keys = (data ?? []).map((a) => a.agreementKey).filter(Boolean);
  // Filet de sécurité : DNRA est l'accord de base exigé sur la quasi-totalité
  // des TLD généralistes. Si l'appel ci-dessus échoue à en renvoyer un
  // seul (ex. TLD non reconnu), on retombe dessus plutôt que d'envoyer un
  // consentement vide qui serait de toute façon rejeté par GoDaddy.
  return keys.length > 0 ? keys : ['DNRA'];
}

type GodaddyContact = {
  nameFirst: string;
  nameLast: string;
  organization?: string;
  email: string;
  phone: string;
  addressMailing: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
};

/**
 * Construit le contact registrant/admin/tech/billing à partir des
 * coordonnées NexAI configurées en environnement (voir env.ts). Le domaine
 * est acheté via le compte GoDaddy de NexAI pour le compte du client — ce
 * sont donc les coordonnées légales de l'exploitant de NexAI qui sont
 * utilisées ici pour les 4 rôles de contact GoDaddy, pas celles du client
 * final (qui n'a pas de compte GoDaddy).
 */
function buildContactFromEnv(): GodaddyContact {
  const required: Array<[string, string]> = [
    ['GODADDY_CONTACT_NAME_FIRST', env.GODADDY_CONTACT_NAME_FIRST],
    ['GODADDY_CONTACT_NAME_LAST', env.GODADDY_CONTACT_NAME_LAST],
    ['GODADDY_CONTACT_EMAIL', env.GODADDY_CONTACT_EMAIL],
    ['GODADDY_CONTACT_PHONE', env.GODADDY_CONTACT_PHONE],
    ['GODADDY_CONTACT_ADDRESS1', env.GODADDY_CONTACT_ADDRESS1],
    ['GODADDY_CONTACT_CITY', env.GODADDY_CONTACT_CITY],
    ['GODADDY_CONTACT_STATE', env.GODADDY_CONTACT_STATE],
    ['GODADDY_CONTACT_POSTAL_CODE', env.GODADDY_CONTACT_POSTAL_CODE],
    ['GODADDY_CONTACT_COUNTRY', env.GODADDY_CONTACT_COUNTRY],
  ];
  const missing = required.filter(([, value]) => !value.trim()).map(([key]) => key);
  if (missing.length > 0) {
    // On refuse d'envoyer une demande d'achat incomplète à GoDaddy (elle
    // serait de toute façon rejetée, mais après avoir potentiellement
    // bloqué des crédits client) — voir resolveDomainCostAndConsume qui
    // débite AVANT ce point, il faut donc échouer proprement pour permettre
    // le remboursement automatique (refundLaunchCharges côté worker).
    throw new AppError(
      `Achat de domaine impossible : coordonnées GoDaddy non configurées sur le serveur (variables manquantes : ${missing.join(', ')}). Contactez le support technique.`,
      503
    );
  }
  return {
    nameFirst: env.GODADDY_CONTACT_NAME_FIRST,
    nameLast: env.GODADDY_CONTACT_NAME_LAST,
    organization: env.GODADDY_CONTACT_ORGANIZATION || undefined,
    email: env.GODADDY_CONTACT_EMAIL,
    phone: env.GODADDY_CONTACT_PHONE,
    addressMailing: {
      address1: env.GODADDY_CONTACT_ADDRESS1,
      address2: env.GODADDY_CONTACT_ADDRESS2 || undefined,
      city: env.GODADDY_CONTACT_CITY,
      state: env.GODADDY_CONTACT_STATE,
      postalCode: env.GODADDY_CONTACT_POSTAL_CODE,
      country: env.GODADDY_CONTACT_COUNTRY,
    },
  };
}

/**
 * Achète un domaine via le compte GoDaddy NexAI (Architecture A.13).
 * Attention : nécessite un compte configuré + consentements de facturation.
 *
 * L'appel doit envoyer domain/period/renewAuto/privacy
 * — GoDaddy REJETTE systématiquement un achat sans l'objet `consent` et les
 * 4 contacts (registrant/admin/tech/billing). C'était un achat non
 * fonctionnel malgré une vérification de disponibilité qui, elle,
 * fonctionnait très bien (d'où l'illusion que "tout est branché").
 */
export async function purchaseDomain(domain: string, years = 1): Promise<void> {
  const contact = buildContactFromEnv();
  const tld = domain.split('.').slice(1).join('.') || domain;
  const agreementKeys = await fetchRequiredAgreementKeys(tld);

  await godaddyFetch('/domains/purchase', {
    method: 'POST',
    body: JSON.stringify({
      consent: {
        agreedAt: new Date().toISOString(),
        agreedBy: env.GODADDY_CONSENT_AGREED_BY_IP,
        agreementKeys,
      },
      contactAdmin: contact,
      contactBilling: contact,
      contactRegistrant: contact,
      contactTech: contact,
      domain,
      period: years,
      // renewAuto: false — DÉLIBÉRÉ, ne pas remettre à true.
      //
      // Les domaines sont enregistrés dans le compte GoDaddy de NexAI. Avec le
      // renouvellement automatique, NexAI payait indéfiniment (23 à 60 $/an
      // selon l'extension) les domaines de clients parfois déjà résiliés,
      // alors que le client n'avait versé que le prix de la 1ère année.
      //
      // Le renouvellement est provisionné mois par mois sur le quota
      // de crédits du client à partir de la 2ème année
      // (getDomainMonthlyRenewalCredits + jobs/worker.ts), puis déclenché
      // explicitement une fois la provision constituée.
      renewAuto: false,
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
