import { AppError } from '@/middleware/errorHandler';

export type SiteMeta = {
  url: string;
  title?: string;
  description?: string;
  h1?: string;
  ogImage?: string;
  logoUrl?: string;
  rawSnippet?: string;
};

/**
 * Récupère les métadonnées publiques d'un site (title, description, h1)
 * pour personnaliser les prompts vidéo / logo.
 * Timeout court + User-Agent correct. Ne scrape jamais le contenu privé.
 */
export async function fetchSiteMeta(rawUrl: string): Promise<SiteMeta> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; NexAI/1.0; +https://nexai.app) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new AppError(`Impossible de lire le site (${res.status})`, 400);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // On accepte quand même, certains sites renvoient text/plain
    }

    const html = (await res.text()).slice(0, 120_000);

    const title =
      match(html, /<title[^>]*>([^<]{1,200})<\/title>/i) ||
      match(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
      match(html, /content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

    const description =
      match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
      match(html, /content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
      match(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);

    const h1 = match(html, /<h1[^>]*>([^<]{1,180})<\/h1>/i);

    const ogImage =
      match(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) ||
      match(html, /content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    const logoUrl = extractLogoUrl(html, url);

    // Petit extrait de texte visible pour Claude (sans scripts)
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);

    return {
      url,
      title: title?.trim(),
      description: description?.trim(),
      h1: h1?.trim(),
      ogImage: ogImage?.trim(),
      logoUrl,
      rawSnippet: cleaned || undefined,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = (err as Error).name === 'AbortError' ? 'Timeout lors de la lecture du site' : (err as Error).message;
    throw new AppError(`Impossible d'analyser l'URL fournie : ${msg}`, 400);
  }
}

function match(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1];
}

/**
 * Tente de détecter le vrai logo du site (pour l'utiliser tel quel dans les
 * vidéos pub — voir décision produit : logo extrait > upload client > IA
 * générée en dernier recours). On ne vérifie pas ici que l'URL charge
 * réellement (voir verifyImageUrl côté appelant), on se contente de
 * détecter le meilleur candidat et de le résoudre en URL absolue.
 *
 * Ordre de priorité (du plus fiable au moins fiable) :
 * 1. <img> dans le header/nav avec un indice "logo" (class/id/alt) — c'est
 *    en général la vraie image de marque, en bonne résolution.
 * 2. apple-touch-icon — généralement une icône carrée haute résolution
 *    (180x180 mini), bien plus utilisable qu'un favicon.ico classique.
 * 3. favicon standard (rel="icon" / "shortcut icon") — dernier recours,
 *    souvent trop petit/basse qualité mais mieux que rien.
 */
function extractLogoUrl(html: string, baseUrl: string): string | undefined {
  const headerMatch = html.match(/<header[\s\S]{0,3000}?<\/header>/i)?.[0] || html.slice(0, 6000);

  const logoImgSrc =
    match(
      headerMatch,
      /<img[^>]+(?:class|id)=["'][^"']*logo[^"']*["'][^>]*\ssrc=["']([^"']+)["']/i
    ) ||
    match(
      headerMatch,
      /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id)=["'][^"']*logo[^"']*["']/i
    ) ||
    match(headerMatch, /<img[^>]+alt=["'][^"']*logo[^"']*["'][^>]*\ssrc=["']([^"']+)["']/i) ||
    match(headerMatch, /<img[^>]+src=["']([^"']+)["'][^>]*alt=["'][^"']*logo[^"']*["']/i);

  const appleTouchIcon = match(
    html,
    /<link[^>]+rel=["']apple-touch-icon["'][^>]*\shref=["']([^"']+)["']/i
  );

  const favicon =
    match(html, /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*\shref=["']([^"']+)["']/i) ||
    match(html, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);

  const candidate = logoImgSrc || appleTouchIcon || favicon;
  if (!candidate) return undefined;

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return undefined;
  }
}
