/**
 * Erreurs techniques d'un fournisseur (IA, hébergement, domaines…) : le
 * client ne doit JAMAIS voir le détail (« Anthropic API error 400… credit
 * balance is too low »). Il voit un message neutre ; l'administrateur garde
 * le détail complet (réponse API pour un compte admin + incident enregistré).
 */

export const MESSAGE_RESEAU_INDISPONIBLE = 'Service momentanément indisponible. Réessayez plus tard.';

const MOTIF_TECHNIQUE =
  /(anthropic|claude|openai|gpt-|\bxai\b|grok|recraft|fal\.ai|\bfal\b|elevenlabs|gemini|google ai|replicate|pexels|cloudinary|bunny|netlify api|godaddy api|porkbun|api error|credit balance|insufficient_quota|quota exceeded|rate.?limit|overloaded|invalid_request_error|request_id|authentication_error|permission_error|api[_ ]key|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|\b(?:5\d\d)\b.*(?:error|erreur)|status code \d{3}|unexpected token|json\.parse|cannot read prop|is not a function|mongo|mongoose|redis|bullmq|stack)/i;

/** Ce message trahit-il un détail technique / un fournisseur ? */
export function estErreurTechnique(message: string | undefined | null): boolean {
  if (!message) return false;
  return MOTIF_TECHNIQUE.test(message);
}

/** Message à montrer : détail pour l'admin, message neutre pour tous les autres. */
export function messagePourClient(message: string, role?: string | null): string {
  if (role === 'admin') return message;
  return estErreurTechnique(message) ? MESSAGE_RESEAU_INDISPONIBLE : message;
}
