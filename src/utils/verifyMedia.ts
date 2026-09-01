/**
 * Vérifie qu'une URL d'image (ou vidéo) est réellement accessible avant de
 * la présenter au client — jamais d'image cassée livrée sur un site généré.
 *
 * Principe : HEAD léger (pas de téléchargement du fichier entier). Certains
 * hébergeurs n'implémentent pas HEAD correctement (405/501) : dans ce cas on
 * retente en GET avec Range pour ne récupérer que les premiers octets, sans
 * jamais rapatrier tout le fichier juste pour un contrôle.
 *
 * Best-effort par design : un timeout ou une erreur réseau => on considère
 * l'image invalide (fail-safe : pas d'image plutôt qu'une image cassée),
 * jamais l'inverse.
 */
export async function verifyImageUrl(
  url: string,
  opts: { timeoutMs?: number; expectedPrefix?: 'image' | 'video' } = {}
): Promise<boolean> {
  const { timeoutMs = 5000, expectedPrefix = 'image' } = opts;
  if (!url) return false;

  const isOk = (res: Response) =>
    res.ok && (res.headers.get('content-type') || '').toLowerCase().startsWith(expectedPrefix);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      if (res.status === 405 || res.status === 501) {
        // HEAD non supporté par cet hébergeur : on retente en GET partiel.
        const res2 = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-1024' },
          signal: controller.signal,
        });
        return isOk(res2);
      }
      return isOk(res);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
