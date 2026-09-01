import type { ISite, ISiteProposal } from '@/models/Site';

/**
 * Construit un "dossier de contenu" du site (bien plus riche qu'un extrait de
 * 800 caractères de la page d'accueil — voir fetchSiteMeta) pour que les
 * prompts vidéo (scènes + narration) puissent couvrir TOUTES les offres du
 * site, pas seulement la première venue.
 *
 * Deux sources, selon ce qui est disponible :
 * - Site NexAI (siteId fourni) : lecture directe en base du HTML déjà
 *   généré (proposal choisie ou la mieux notée). Aucune requête réseau,
 *   100% fiable, fonctionne même si le site n'est pas encore lancé.
 * - Site externe (siteUrl fourni, pas de siteId) : crawl best-effort de la
 *   home + jusqu'à MAX_EXTERNAL_PAGES pages internes dont l'URL/le texte du
 *   lien contient un mot-clé pertinent (services, tarifs, offres...).
 *
 * Best-effort total : toute erreur réseau/parsing retombe sur un dossier
 * vide plutôt que de faire échouer la génération vidéo — ce service ne doit
 * jamais être un point de panne pour enqueueVideoAd.
 */

export interface SiteContentDossier {
  /** Texte structuré (titres/listes préservés comme repères), plafonné,
   * prêt à être injecté tel quel dans les prompts Claude (scènes + narration). */
  dossierText: string;
  /** Jusqu'à 4 offres/services distincts et courts, extraits du dossier —
   * utilisés pour l'overlay à l'écran et pour décider si une recommandation
   * de format plus long doit être proposée (non-bloquante). */
  offerHighlights: string[];
  pagesAnalyzed: number;
  source: 'nexai_db' | 'external_crawl' | 'none';
}

const EMPTY_DOSSIER: SiteContentDossier = {
  dossierText: '',
  offerHighlights: [],
  pagesAnalyzed: 0,
  source: 'none',
};

const MAX_DOSSIER_CHARS = 9000;
const MAX_EXTERNAL_PAGES = 5;
const CRAWL_KEYWORDS = [
  'service', 'offre', 'offres', 'tarif', 'tarifs', 'prix', 'pricing',
  'produit', 'produits', 'shop', 'boutique', 'catalogue', 'menu',
  'prestation', 'prestations', 'about', 'a-propos', 'apropos',
];

export async function buildSiteContentDossier(params: {
  site?: ISite | null;
  chosenProposalId?: string;
  externalUrl?: string;
}): Promise<SiteContentDossier> {
  try {
    if (params.site) {
      return buildFromNexaiSite(params.site, params.chosenProposalId);
    }
    if (params.externalUrl) {
      return await buildFromExternalCrawl(params.externalUrl);
    }
  } catch (err) {
    console.warn('[site-content-analysis] Dossier indisponible, poursuite sans dossier', err);
  }
  return EMPTY_DOSSIER;
}

// ─────────────────────────────────────────────────────────────────────────
// Source 1 : site NexAI existant (lecture base, aucun réseau)
// ─────────────────────────────────────────────────────────────────────────

function pickProposal(site: ISite, chosenProposalId?: string): ISiteProposal | null {
  if (!site.proposals?.length) return null;
  const wantedId = chosenProposalId || site.chosenProposalId;
  if (wantedId) {
    const found = site.proposals.find((p) => p.versionId === wantedId);
    if (found) return found;
  }
  // Sinon la mieux notée, sinon la première.
  const sorted = [...site.proposals].sort((a, b) => (b.score || 0) - (a.score || 0));
  return sorted[0] || null;
}

function buildFromNexaiSite(site: ISite, chosenProposalId?: string): SiteContentDossier {
  const proposal = pickProposal(site, chosenProposalId);
  if (!proposal) return EMPTY_DOSSIER;

  const pages: { title: string; html: string }[] = [];
  if (proposal.htmlDemo) pages.push({ title: 'Accueil', html: proposal.htmlDemo });
  for (const p of proposal.pages || []) {
    if (p.html) pages.push({ title: p.title || p.slug, html: p.html });
  }
  if (pages.length === 0) return EMPTY_DOSSIER;

  const { dossierText, offerHighlights } = assembleDossier(pages);
  return { dossierText, offerHighlights, pagesAnalyzed: pages.length, source: 'nexai_db' };
}

// ─────────────────────────────────────────────────────────────────────────
// Source 2 : site externe (crawl best-effort)
// ─────────────────────────────────────────────────────────────────────────

async function fetchHtml(url: string, timeoutMs = 6000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NexAI/1.0; +https://nexai.app) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.text()).slice(0, 300_000);
  } catch {
    return null;
  }
}

function extractInternalLinks(html: string, baseUrl: string, max: number): string[] {
  const found = new Set<string>();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const base = new URL(baseUrl);
  while ((m = re.exec(html)) && found.size < max * 3) {
    const href = m[1];
    const anchorText = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.hostname !== base.hostname) continue; // pages internes uniquement
    const pathAndText = (abs.pathname + ' ' + anchorText).toLowerCase();
    if (!CRAWL_KEYWORDS.some((k) => pathAndText.includes(k))) continue;
    abs.hash = '';
    found.add(abs.toString());
  }
  return Array.from(found).slice(0, max);
}

async function buildFromExternalCrawl(rawUrl: string): Promise<SiteContentDossier> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const homeHtml = await fetchHtml(url);
  if (!homeHtml) return EMPTY_DOSSIER;

  const pages: { title: string; html: string }[] = [{ title: 'Accueil', html: homeHtml }];

  const internalLinks = extractInternalLinks(homeHtml, url, MAX_EXTERNAL_PAGES);
  for (const link of internalLinks) {
    const html = await fetchHtml(link, 5000);
    if (html) pages.push({ title: link, html });
  }

  const { dossierText, offerHighlights } = assembleDossier(pages);
  return { dossierText, offerHighlights, pagesAnalyzed: pages.length, source: 'external_crawl' };
}

// ─────────────────────────────────────────────────────────────────────────
// Extraction / mise en forme communes
// ─────────────────────────────────────────────────────────────────────────

/** Convertit du HTML brut en texte structuré : titres (h1-h3) et éléments de
 * liste (li) préservés comme repères ("## Titre", "- item"), tout le reste
 * réduit à du texte simple. Aide Claude à repérer les offres distinctes
 * plutôt que de recevoir un mur de texte plat. */
function htmlToStructuredText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, inner) => {
      const marker = tag.toLowerCase() === 'h1' ? '#' : '##';
      return `\n${marker} ${stripTags(inner)}\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripTags(inner)}`)
    .replace(/<\/(p|div|section|article|br)>/gi, '\n');
  // Supprime les balises restantes SANS toucher aux \n déjà insérés ci-dessus
  // (stripTags() collapse tout \s, y compris les retours à la ligne — ce
  // qui détruirait la séparation ## titre / - item qu'on vient de créer).
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Extrait jusqu'à 4 offres/services courts et distincts à partir des titres
 * et items de liste du dossier — utilisés pour l'overlay écran et pour la
 * recommandation de format. Heuristique volontairement simple (longueur +
 * dédoublonnage) : la sélection fine du sens revient à Claude dans les
 * prompts, ceci n'est qu'un signal d'appoint pour l'UI. */
function extractOfferHighlights(pagesText: string[], max = 4): string[] {
  const candidates: string[] = [];
  for (const text of pagesText) {
    for (const line of text.split('\n')) {
      // Uniquement les titres de niveau service (## = h2/h3) et les items de
      // liste (-) — jamais le titre de niveau page/marque (# = h1), qui
      // n'est pas une "offre" mais le nom du site/de la section.
      if (!/^##\s|^-\s/.test(line)) continue;
      const clean = line.replace(/^##\s*|^-\s*/, '').trim();
      if (clean.length >= 3 && clean.length <= 42 && /[a-zA-ZÀ-ÿ]/.test(clean)) {
        candidates.push(clean);
      }
    }
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
    if (result.length >= max) break;
  }
  return result;
}

function assembleDossier(pages: { title: string; html: string }[]): {
  dossierText: string;
  offerHighlights: string[];
} {
  const perPageBudget = Math.max(500, Math.floor(MAX_DOSSIER_CHARS / Math.max(1, pages.length)));
  const structuredPages: string[] = [];
  const sections: string[] = [];

  for (const page of pages) {
    const structured = htmlToStructuredText(page.html).slice(0, perPageBudget);
    if (!structured) continue;
    structuredPages.push(structured);
    sections.push(`### Page : ${page.title}\n${structured}`);
  }

  const dossierText = sections.join('\n\n').slice(0, MAX_DOSSIER_CHARS);
  const offerHighlights = extractOfferHighlights(structuredPages);
  return { dossierText, offerHighlights };
}
