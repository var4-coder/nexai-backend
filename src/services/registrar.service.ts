import {
  addNetlifyDnsRecord as addGodaddyDns,
  checkDomainAvailability as checkGodaddy,
  getDomainDetails as getGodaddyDetails,
  purchaseDomain as purchaseGodaddy,
  renewDomain as renewGodaddy,
} from '@/services/godaddy.service';
import {
  addPorkbunNetlifyDns,
  checkPorkbunAvailability,
  getPorkbunDomainDetails,
  purchasePorkbunDomain,
  renewPorkbunDomain,
} from '@/services/porkbun.service';
import { lireVendeurDomaine, type VendeurDomaine } from '@/services/registrar-reglage.service';

/**
 * Point unique d'achat. Le type interne reste "godaddy" dans le parcours
 * client (sous-domaine / achat / domaine déjà possédé) pour ne pas casser
 * les sites déjà lancés. Seul le vendeur réel change.
 */
export async function checkDomainAvailability(domain: string): Promise<{ available: boolean; priceUsd: number | null }> {
  const vendeur = await lireVendeurDomaine();
  if (vendeur === 'porkbun') {
    const r = await checkPorkbunAvailability(domain);
    return { available: r.available, priceUsd: r.priceUsd };
  }
  return checkGodaddy(domain);
}

export async function purchaseDomain(domain: string, years = 1): Promise<void> {
  const vendeur = await lireVendeurDomaine();
  if (vendeur === 'porkbun') {
    await purchasePorkbunDomain(domain);
    return;
  }
  await purchaseGodaddy(domain, years);
}

export async function addNetlifyDnsRecord(domain: string, netlifyHost: string): Promise<void> {
  const vendeur = await lireVendeurDomaine();
  if (vendeur === 'porkbun') {
    await addPorkbunNetlifyDns(domain, netlifyHost);
    return;
  }
  await addGodaddyDns(domain, netlifyHost);
}

export async function renewDomainChez(vendeur: VendeurDomaine, domain: string): Promise<void> {
  if (vendeur === 'porkbun') {
    await renewPorkbunDomain(domain);
    return;
  }
  await renewGodaddy(domain, 1);
}

export async function detailsDomaineChez(
  vendeur: VendeurDomaine,
  domain: string
): Promise<{ expires?: string }> {
  if (vendeur === 'porkbun') return getPorkbunDomainDetails(domain);
  const details = await getGodaddyDetails(domain);
  return { expires: details.expires ?? undefined };
}
