import { env } from '@/config/env';
import { injecterSuivi } from '@/services/site-visits.service';
import { injectPaymentLink, injectPublicBackendScript } from '@/utils/injectBackend';
import { retirerContenuExemple } from '@/utils/contenuExemple';
import { avecKit, sansKit, lireFichierKit, utiliseGsap, FICHIERS_GSAP } from '@/services/kit.service';
import { construirePagesLegales } from '@/services/pages-legales.service';

/**
 * PRÉPARATION D'UN SITE POUR LA MISE EN LIGNE — un seul endroit, utilisé
 * par la mise en ligne (worker) et par les redéploiements (édition rapide
 * Agence). Avant, chaque chemin refaisait sa propre préparation et le
 * redéploiement perdait le suivi des visites.
 *
 * Pour chaque page : suivi des visites, lien de paiement réel, retrait des
 * avis d'exemple (data-env="production"), adresse réelle du site à la place
 * de __SITE_URL__, kit NexAI en version « publication » (GSAP servi par le
 * site lui-même, /kit/…), envoi des formulaires vers le backend public.
 * S'ajoutent : pages légales (mentions légales, confidentialité, CGV si le
 * client les a données) et fichiers GSAP.
 */

export interface PageSite {
  slug: string;
  title: string;
  html: string;
}

export interface FichierPublie {
  path: string;
  content: string | Buffer;
}

/**
 * Adresse publique du site, connue dès la commande de mise en ligne :
 * domaine du client (acheté ou existant) ou sous-domaine NexAI.
 */
export function adresseDuSite(params: { domainName?: string; subdomainSlug?: string }): string {
  const domaine =
    params.domainName?.trim().toLowerCase() ||
    (params.subdomainSlug ? `${params.subdomainSlug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}` : '');
  return domaine ? `https://${domaine.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
}

/** Remplace le repère __SITE_URL__ (SCHEMA, liens absolus) par l'adresse réelle. */
export function remplacerAdresseSite(html: string, siteUrl: string): string {
  if (!siteUrl) return html;
  return html.split('__SITE_URL__').join(siteUrl);
}

export function preparerPagesPourPublication(params: {
  siteId: string;
  publicApiKey: string;
  pages: PageSite[];
  brief: Record<string, unknown>;
  nomSite: string;
  siteUrl: string;
  paymentLink?: string;
}): { pages: PageSite[]; gsap: boolean } {
  const { siteId, siteUrl } = params;

  const nettoyer = (html: string) => {
    let h = sansKit(html ?? '');
    if (params.paymentLink) h = injectPaymentLink(h, params.paymentLink);
    h = retirerContenuExemple(h).html;
    return remplacerAdresseSite(h, siteUrl);
  };
  const base = params.pages.map((p) => ({ ...p, html: nettoyer(p.html) }));

  // Pages légales construites sur l'accueil (même en-tête, pied de page, famille).
  const accueil = base.find((p) => p.slug === 'index') ?? base[0];
  const legales = accueil
    ? construirePagesLegales({ indexHtml: accueil.html, brief: params.brief, nomSite: params.nomSite, siteUrl })
        .filter((l) => !base.some((p) => p.slug === l.slug))
        .map((l) => ({ ...l, html: retirerContenuExemple(l.html).html }))
    : [];

  const finales = [...base, ...legales].map((p) => {
    const avecSuivi = injecterSuivi(p.html, siteId);
    const avecLeKit = avecKit(avecSuivi, 'publication');
    return {
      ...p,
      html: injectPublicBackendScript({
        html: avecLeKit,
        siteId,
        publicApiKey: params.publicApiKey,
        apiBaseUrl: env.PUBLIC_API_BASE_URL,
      }),
    };
  });
  return { pages: finales, gsap: finales.some((p) => utiliseGsap(p.html)) };
}

/** Copie servie à /slug/ : liens relatifs ramenés à la racine (« menu.html » → « /menu.html »). */
function liensDepuisRacine(html: string): string {
  return html.replace(
    /\b(href|src)=(["'])(?!https?:|\/|#|mailto:|tel:|sms:|data:|javascript:)([^"']+)\2/gi,
    (_m, attr: string, q: string, url: string) => `${attr}=${q}/${url.replace(/^\.\//, '')}${q}`
  );
}

/**
 * Fichiers d'un site statique : `slug.html` pour chaque page (et
 * `slug/index.html`, pour que l'adresse sans « .html » — /mentions-legales —
 * fonctionne partout), plus les fichiers GSAP si une page les charge.
 */
export function fichiersStatiques(pages: PageSite[], gsap: boolean, siteUrl?: string): FichierPublie[] {
  const fichiers: FichierPublie[] = [];
  // Référencement : plan du site + robots.txt, pour que Google découvre
  // toutes les pages (et pas seulement l'accueil).
  if (siteUrl) {
    const base = siteUrl.replace(/\/+$/, '');
    const jour = new Date().toISOString().slice(0, 10);
    const urls = pages.map((p) => (p.slug === 'index' ? `${base}/` : `${base}/${p.slug}`));
    fichiers.push({
      path: 'sitemap.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.map((u) => `  <url><loc>${u}</loc><lastmod>${jour}</lastmod></url>`).join('\n') +
        '\n</urlset>\n',
    });
    fichiers.push({ path: 'robots.txt', content: `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n` });
  }
  for (const p of pages) {
    if (p.slug === 'index') {
      fichiers.push({ path: 'index.html', content: p.html });
      continue;
    }
    fichiers.push({ path: `${p.slug}.html`, content: p.html });
    fichiers.push({ path: `${p.slug}/index.html`, content: liensDepuisRacine(p.html) });
  }
  if (gsap) {
    for (const nom of FICHIERS_GSAP) fichiers.push({ path: `kit/${nom}`, content: lireFichierKit(nom) });
  }
  return fichiers;
}
