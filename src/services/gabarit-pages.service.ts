/**
 * Gabarit commun des pages d'un site (décision du 03/10/2026, option 3B).
 *
 * Le backend découpe la page d'accueil (déjà jugée) en un gabarit :
 * en-tête du document (<head> : polices, styles, variables), en-tête de page
 * (<header>) et pied de page (<footer>). Les pages intérieures sont ensuite
 * ASSEMBLÉES par le code : gabarit de l'accueil + contenu central écrit par
 * le codeur. Le style est ainsi identique à 100 % sur tout le site, et le
 * codeur écrit beaucoup moins (seulement le contenu propre à la page).
 *
 * Filet : si le découpage de l'accueil échoue (page écrite sans <header> ou
 * sans <footer> repérables), l'appelant revient à l'ancien mode (le codeur
 * reçoit le début de l'accueil et écrit toute la page).
 */

export interface GabaritSite {
  /** Balise ouvrante <html …> de l'accueil (déclaration de la famille imposée). */
  ouvertureHtml: string;
  /** Contenu du <head> de l'accueil. */
  head: string;
  /** Balise ouvrante <body …>. */
  ouvertureBody: string;
  /**
   * En-tête collé tel quel. null quand l'en-tête de l'accueil contient aussi
   * l'ouverture (photo, <h1>) : on ne peut pas le recopier sur une autre page.
   * Le codeur écrit alors une barre de navigation à partir de `navReference`.
   */
  header: string | null;
  /** Navigation de l'accueil, en référence (classes et liens à reprendre). */
  navReference: string;
  footer: string;
  /** CSS de l'accueil (contenu des blocs <style>), pour que le codeur réutilise les mêmes classes. */
  css: string;
  /**
   * Scripts en ligne de l'accueil SANS formulaire (menu mobile, en-tête…) :
   * recopiés par le système dans chaque page, chacun isolé (une erreur dans
   * l'un ne bloque pas les autres).
   */
  scriptsRepris: string[];
  /**
   * Scripts de l'accueil qui montent un formulaire : jamais recopiés (le
   * formulaire n'existe que sur l'accueil), donnés au codeur pour qu'il
   * reprenne, si besoin, la partie « menu » qu'ils contiennent.
   */
  scriptsReference: string;
}

const MAX_BLOC = 25000;

/** Trouve un élément équilibré (<tag …> … </tag>) à partir d'un index d'ouverture. */
function elementEquilibre(html: string, tag: string, debut: number): { debut: number; fin: number } | null {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi');
  re.lastIndex = debut;
  let profondeur = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] === '/') {
      profondeur--;
      if (profondeur === 0) return { debut, fin: m.index + m[0].length };
    } else {
      profondeur++;
    }
  }
  return null;
}

function premiereOuverture(html: string, tag: string, aPartirDe = 0): number {
  const re = new RegExp(`<${tag}(?=[\\s>])`, 'i');
  const idx = html.slice(aPartirDe).search(re);
  return idx < 0 ? -1 : aPartirDe + idx;
}

/** Ouvertures de <footer> qui ne sont pas imbriquées dans un autre élément <footer>. */
function dernierFooterRacine(corps: string): { debut: number; fin: number } | null {
  let pos = 0;
  let dernier: { debut: number; fin: number } | null = null;
  for (;;) {
    const idx = premiereOuverture(corps, 'footer', pos);
    if (idx < 0) break;
    const el = elementEquilibre(corps, 'footer', idx);
    if (!el) break;
    dernier = el;
    pos = el.fin;
  }
  return dernier;
}

export function extraireGabarit(htmlAccueil: string): GabaritSite | null {
  try {
    const html = htmlAccueil;
    const ouvHtml = html.match(/<html\b[^>]*>/i);
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    const ouvBody = html.match(/<body\b[^>]*>/i);
    if (!ouvHtml || !head || !ouvBody || ouvBody.index === undefined) return null;
    const corpsDebut = ouvBody.index + ouvBody[0].length;
    const corpsFin = html.search(/<\/body>/i);
    if (corpsFin < 0) return null;
    const corps = html.slice(corpsDebut, corpsFin);

    // L'en-tête de page : premier <header> du corps (avant <main> s'il existe).
    const idxHeader = premiereOuverture(corps, 'header');
    const idxMain = premiereOuverture(corps, 'main');
    if (idxHeader < 0 || (idxMain >= 0 && idxHeader > idxMain)) return null;
    const elHeader = elementEquilibre(corps, 'header', idxHeader);
    if (!elHeader) return null;
    const headerAccueil = corps.slice(elHeader.debut, elHeader.fin);
    // En-tête qui porte aussi l'ouverture (photo de couverture, titre principal) : non recopiable.
    const avecOuverture = /<h1\b|data-hero-zone|data-nexai-id=(["'])hero\1/i.test(headerAccueil);
    let navReference = headerAccueil;
    const idxNav = premiereOuverture(headerAccueil, 'nav');
    if (idxNav >= 0) {
      const elNav = elementEquilibre(headerAccueil, 'nav', idxNav);
      if (elNav) navReference = headerAccueil.slice(elNav.debut, elNav.fin);
    }
    const header = avecOuverture ? null : headerAccueil;

    // Le pied de page : dernier <footer> « racine » situé après l'en-tête.
    const elFooter = dernierFooterRacine(corps.slice(elHeader.fin));
    if (!elFooter) return null;
    const footer = corps.slice(elHeader.fin).slice(elFooter.debut, elFooter.fin);

    if (!/<a\b/i.test(navReference) || headerAccueil.length > MAX_BLOC * 2 || footer.length > MAX_BLOC) return null;
    if (header && header.length > MAX_BLOC) return null;

    const css = Array.from(head[1].matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      .map((m) => m[1].trim())
      .join('\n');
    const scripts = Array.from(corps.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
      .filter((m) => !/\bsrc=|application\/ld\+json|type=(["'])module\1/i.test(m[1]))
      .map((m) => m[2].trim())
      .filter(Boolean);
    const scriptsRepris = scripts.filter((sc) => !/NexaiForm/.test(sc));
    const scriptsReference = scripts.filter((sc) => /NexaiForm/.test(sc)).join('\n;\n');

    return {
      ouvertureHtml: ouvHtml[0],
      head: head[1],
      ouvertureBody: ouvBody[0],
      header,
      navReference: navReference.slice(0, 8000),
      footer,
      css,
      scriptsRepris,
      scriptsReference,
    };
  } catch {
    return null;
  }
}

/** Texte déjà écrit en HTML par le codeur : on ne ré-échappe pas les entités (&amp;…), seulement les chevrons et guillemets. */
function echapperHtml(s: string): string {
  return s.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Lien actif de la navigation : aria-current="page" sur le lien de la page courante. */
function marquerLienActif(header: string, slug: string): string {
  const cible = slug === 'index' ? 'index.html' : `${slug}.html`;
  const sansActif = header.replace(/\s+aria-current=(["'])page\1/gi, '');
  return sansActif.replace(/<a\b([^>]*\bhref=(["'])(?:\.\/|\/)?([^"']*)\2[^>]*)>/gi, (tout, attrs: string, _q, href: string) =>
    href === cible ? `<a${attrs} aria-current="page">` : tout
  );
}

/**
 * Assemble une page intérieure : gabarit de l'accueil + contenu écrit par le
 * codeur. Le codeur peut renvoyer une page complète ou seulement son contenu :
 * on garde son <title>, sa description, ses <style> propres, son contenu
 * central (<main>) et ses scripts ; tout le reste vient de l'accueil.
 * Renvoie null si aucun contenu central exploitable n'a été trouvé.
 */
export function assemblerPage(
  gabarit: GabaritSite,
  sortieCodeur: string,
  page: { slug: string; title: string }
): string | null {
  const brut = sortieCodeur.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

  const titre = brut.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || page.title;
  const description = brut.match(/<meta\s+name=(["'])description\1\s+content=(["'])([\s\S]*?)\2[^>]*>/i)?.[3];
  // En-tête : celui de l'accueil, ou (accueil avec ouverture dans l'en-tête) celui écrit par le codeur.
  let headerPage = gabarit.header;
  if (!headerPage) {
    const idxH = premiereOuverture(brut, 'header');
    const el = idxH >= 0 ? elementEquilibre(brut, 'header', idxH) : null;
    if (!el) return null;
    headerPage = brut.slice(el.debut, el.fin);
  }

  // Contenu central : <main> si présent, sinon le corps sans en-tête ni pied de page.
  let main: string | null = null;
  const idxMain = premiereOuverture(brut, 'main');
  if (idxMain >= 0) {
    const el = elementEquilibre(brut, 'main', idxMain);
    if (el) main = brut.slice(el.debut, el.fin);
  }
  const mainVientDuCodeur = !!main;
  if (!main) {
    const corps = brut.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? brut;
    let contenu = corps
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
    const idxH = premiereOuverture(contenu, 'header');
    if (idxH >= 0) {
      const el = elementEquilibre(contenu, 'header', idxH);
      if (el) contenu = contenu.slice(0, el.debut) + contenu.slice(el.fin);
    }
    const f = dernierFooterRacine(contenu);
    if (f) contenu = contenu.slice(0, f.debut) + contenu.slice(f.fin);
    contenu = contenu.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '').trim();
    if (contenu.replace(/<[^>]+>/g, '').trim().length < 40) return null;
    main = `<main id="contenu">\n${contenu}\n</main>`;
  }
  // Styles, scripts et <noscript> HORS du contenu central (ceux du <main> y restent, sans doublon).
  const horsMain = mainVientDuCodeur && main ? brut.replace(main, '') : brut;
  const styles = Array.from(horsMain.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1].trim())
    .filter(Boolean);
  const scripts = Array.from(horsMain.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter((m) => !/\bsrc=/i.test(m[1]))
    .map((m) => `<script${m[1]}>${m[2]}</script>`);
  const noscripts = Array.from(horsMain.matchAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi)).map((m) => m[0]);

  if (main.replace(/<[^>]+>/g, '').trim().length < 40) return null;

  // <head> de l'accueil : titre et description remplacés, schéma de l'accueil retiré (propre à l'accueil).
  let head = gabarit.head
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${echapperHtml(titre.replace(/<[^>]+>/g, ''))}</title>`)
    .replace(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, '');
  if (description) {
    const meta = `<meta name="description" content="${echapperHtml(description)}">`;
    head = /<meta\s+name=(["'])description\1[^>]*>/i.test(head)
      ? head.replace(/<meta\s+name=(["'])description\1[^>]*>/i, () => meta)
      : `${head}\n${meta}`;
  }
  if (!/<title\b/i.test(head)) head = `<title>${echapperHtml(titre)}</title>\n${head}`;
  if (styles.length > 0) head += `\n<style data-nexai-page="${page.slug}">\n${styles.join('\n')}\n</style>`;

  return [
    '<!doctype html>',
    gabarit.ouvertureHtml,
    '<head>',
    head.trim(),
    '</head>',
    gabarit.ouvertureBody,
    marquerLienActif(headerPage, page.slug),
    main,
    gabarit.footer,
    ...noscripts,
    ...gabarit.scriptsRepris.map((sc) => `<script data-nexai-gabarit>try{\n${sc}\n}catch(e){}</script>`),
    ...scripts,
    '</body>',
    '</html>',
  ].join('\n');
}
