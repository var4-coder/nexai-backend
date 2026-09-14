/**
 * Blocage des adresses email jetables — Architecture v6, section 24.
 *
 * Objectif : empêcher la création en série de comptes d'essai (15 crédits
 * offerts à chaque fois). Les services jetables permettent de générer une
 * adresse valide en quelques secondes, sans aucune traçabilité.
 *
 * Liste volontairement limitée aux services les plus utilisés : une liste
 * exhaustive est impossible à maintenir et bloquerait des clients légitimes.
 * C'est un filtre de volume, pas une barrière absolue — les autres
 * protections (IP, empreinte appareil, plafond quotidien) prennent le relais.
 */
const DOMAINES_JETABLES = new Set([
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'mailinator.com', 'mailinator.net',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com',
  'temp-mail.org', 'tempmail.com', 'temp-mail.io', 'tempmailo.com',
  '10minutemail.com', '10minutemail.net', '20minutemail.com',
  'throwawaymail.com', 'trashmail.com', 'trashmail.net', 'getnada.com',
  'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mytemp.email',
  'mohmal.com', 'emailondeck.com', 'spamgourmet.com', 'mailnesia.com',
  'inboxbear.com', 'tempr.email', 'discard.email', 'moakt.com',
  'luxusmail.org', 'emailfake.com', 'tmpmail.org', 'burnermail.io',
  'anonymbox.com', 'mailcatch.com', 'jetable.org', 'spambox.us',
]);

/** Motifs génériques : couvre les variantes de domaine d'un même service. */
const MOTIFS_SUSPECTS = [
  /^temp[-.]?mail\./i,
  /^throwaway/i,
  /^trash[-.]?mail/i,
  /\d+minute(s)?mail\./i,
  /^mailinator\./i,
  /^yopmail\./i,
];

export function estEmailJetable(email: string): boolean {
  const domaine = email.toLowerCase().trim().split('@')[1];
  if (!domaine) return false;
  if (DOMAINES_JETABLES.has(domaine)) return true;
  return MOTIFS_SUSPECTS.some((r) => r.test(domaine));
}

/** Message affiché au client — reste courtois : un vrai client peut être touché. */
export const MESSAGE_EMAIL_JETABLE =
  "Cette adresse email temporaire n'est pas acceptée. Utilisez une adresse personnelle ou professionnelle habituelle pour créer votre compte.";
