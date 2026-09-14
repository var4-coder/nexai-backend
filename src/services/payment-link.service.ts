import dns from 'dns/promises';
import { isIP } from 'net';
import { AppError } from '@/middleware/errorHandler';

/**
 * Validation du lien de paiement personnel avant tout lancement de site
 * (Partie D.9). Objectif : éviter qu'un client mette en ligne un site avec
 * un lien de paiement invalide, mal copié, ou qui ne répond pas — quel que
 * soit le prestataire choisi (Chariow, Maketou, Stripe, autre). Aucune
 * différence de traitement selon le prestataire : la validation ne regarde
 * QUE le lien, jamais le libellé choisi par le client.
 *
 * Bloque aussi, par sécurité serveur (anti-SSRF), toute résolution vers une
 * IP privée/locale/loopback — un client (ou un attaquant) ne doit jamais
 * pouvoir faire pointer ce champ vers l'infrastructure interne.
 */

const FETCH_TIMEOUT_MS = 6000;

function isPrivateOrLocalIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata (cloud)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    return false;
  }
  return true; // pas une IP valide → refusé par prudence
}

export interface PaymentLinkValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Valide un lien de paiement personnel : format https, résolution DNS
 * (bloque IP privées/locales), puis une requête réelle avec timeout pour
 * s'assurer que le lien répond effectivement (pas de 404, pas de timeout).
 */
export async function validatePaymentLink(rawUrl: string): Promise<PaymentLinkValidationResult> {
  const url = (rawUrl || '').trim();
  if (!url) return { valid: false, reason: 'Aucun lien de paiement fourni.' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Le lien de paiement n\'est pas une URL valide.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Le lien de paiement doit être en https:// (sécurisé).' };
  }

  const hostname = parsed.hostname;
  if (!hostname || hostname === 'localhost') {
    return { valid: false, reason: 'Ce lien ne pointe pas vers une adresse valide.' };
  }

  // Résolution DNS — anti-SSRF : on refuse toute IP privée/locale/metadata.
  let addresses: string[] = [];
  try {
    const direct = isIP(hostname);
    if (direct) {
      addresses = [hostname];
    } else {
      const records = await dns.lookup(hostname, { all: true });
      addresses = records.map((r) => r.address);
    }
  } catch {
    return { valid: false, reason: "Impossible de résoudre l'adresse de ce lien. Vérifiez qu'il est correct." };
  }

  if (addresses.length === 0 || addresses.some(isPrivateOrLocalIp)) {
    return { valid: false, reason: 'Ce lien pointe vers une adresse non autorisée.' };
  }

  // Requête réelle avec timeout — confirme que le lien répond bien.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });
      // Certains prestataires (Stripe Payment Links, Chariow…) refusent HEAD → on retente en GET.
      if (res.status === 405 || res.status === 501) {
        res = await fetch(parsed.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        return { valid: false, reason: "Le lien de paiement met trop de temps à répondre. Vérifiez qu'il est actif." };
      }
      return { valid: false, reason: "Le lien de paiement ne répond pas. Vérifiez qu'il est correct et actif." };
    }

    if (res.status >= 400) {
      return { valid: false, reason: `Le lien de paiement répond en erreur (code ${res.status}). Vérifiez qu'il est correct.` };
    }

    return { valid: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Variante qui lève une AppError directement — pratique dans les routes/services
 * où un lien invalide doit bloquer net le lancement (avant tout débit de crédits).
 */
export async function assertValidPaymentLink(rawUrl: string): Promise<void> {
  const result = await validatePaymentLink(rawUrl);
  if (!result.valid) {
    throw new AppError(
      result.reason || 'Le lien de paiement fourni est invalide.',
      422
    );
  }
}
