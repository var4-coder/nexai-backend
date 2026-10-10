import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Captcha Cloudflare Turnstile — bloque les robots qui créent des comptes
 * d'essai en masse. Gratuit, sans compte Google ni connexion Google.
 *
 * Désactivé tant que TURNSTILE_SECRET_KEY n'est pas renseignée sur Render :
 * l'inscription fonctionne alors exactement comme avant.
 */
export function captchaActif(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

export async function verifierCaptcha(jeton: string | undefined, ip?: string): Promise<void> {
  if (!captchaActif()) return;
  if (!jeton) throw new AppError('Merci de cocher la case de vérification avant de créer votre compte.', 400);
  let ok = false;
  try {
    const corps = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: jeton });
    if (ip) corps.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: corps,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    ok = data?.success === true;
  } catch {
    // Service de vérification injoignable : on n'empêche pas une vraie
    // inscription pour autant (les autres garde-fous restent actifs).
    console.warn('[captcha] Vérification Turnstile injoignable — inscription acceptée');
    return;
  }
  if (!ok) throw new AppError('La vérification a échoué. Rechargez la page et cochez à nouveau la case.', 400);
}
