/**
 * PAGES LÉGALES créées à la mise en ligne (LEGAL.md, Librairie v8) :
 *   · Mentions légales      — toujours ;
 *   · Confidentialité       — dès qu'un formulaire existe (tous les métiers) ;
 *   · CGV                   — seulement si le client a donné ses conditions
 *                             de vente dans la conversation (facultatif,
 *                             décision du 02/10/2026).
 *
 * Règle LEGAL.md : AUCUNE donnée juridique inventée. Ce que le brief ne
 * donne pas reste un repère visible `{{champ}}`, dans un élément
 * data-nexai-id : le client le complète dans « Modifier mon site ».
 *
 * Les pages reprennent l'en-tête, le pied de page, les variables et les
 * polices de l'accueil : même famille, même navigation (TH6).
 */

/** Hébergeur des sites NexAI (valeurs réelles, vérifiées sur netlify.com/legal le 02/10/2026). */
export const HEBERGEUR = {
  nom: 'Netlify, Inc.',
  adresse: '101 2nd Street, San Francisco, CA 94105-2239, États-Unis',
  adresseEn: '101 2nd Street, San Francisco, CA 94105-2239, United States',
};

export interface PageLegale {
  slug: string;
  title: string;
  html: string;
}

function echapper(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function texte(brief: Record<string, unknown>, ...cles: string[]): string {
  for (const c of cles) {
    const v = brief[c];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const RE_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const RE_TEL = /\+?\d[\d\s.-]{7,}\d/;

/** Valeur du brief, sinon repère {{champ}} modifiable par le client. */
function champ(id: string, valeur: string, repere: string): string {
  return valeur
    ? `<span data-nexai-id="legal-${id}">${echapper(valeur)}</span>`
    : `<span data-nexai-id="legal-${id}">{{${repere}}}</span>`;
}

interface Contexte {
  brief: Record<string, unknown>;
  nom: string;
  siteUrl: string;
  en: boolean;
}

function infosContact(brief: Record<string, unknown>) {
  const contact = texte(brief, 'contact');
  const email = texte(brief, 'email', 'emailContact') || (RE_EMAIL.exec(contact)?.[0] ?? '');
  const tel = texte(brief, 'telephone', 'telephoneContact') || (RE_TEL.exec(contact)?.[0]?.trim() ?? '');
  const adresse = texte(brief, 'adresse', 'adresseSiege');
  return { email, tel, adresse };
}

function corpsMentions(c: Contexte): string {
  const { email, tel, adresse } = infosContact(c.brief);
  const b = c.brief;
  if (c.en) {
    return `<h1>Legal notice</h1>
<h2>Website publisher</h2>
<p>Trade name: <span data-nexai-id="legal-nom">${echapper(c.nom)}</span><br>
Legal name: ${champ('raison-sociale', texte(b, 'raisonSociale'), 'raisonSociale')}<br>
Legal form: ${champ('forme', texte(b, 'formeJuridique'), 'formeJuridique')}<br>
Share capital: ${champ('capital', texte(b, 'capitalSocial'), 'capitalSocial')}<br>
Registered address: ${champ('adresse', adresse, 'adresseSiege')}<br>
Registration number: ${champ('rcs', texte(b, 'numeroRCS', 'rccm'), 'numeroRCS')}<br>
Email: ${champ('email', email, 'emailContact')}<br>
Phone: ${champ('telephone', tel, 'telephoneContact')}</p>
<h2>Hosting</h2>
<p>${HEBERGEUR.nom}, ${HEBERGEUR.adresseEn}.</p>
<h2>Website address</h2>
<p>${echapper(c.siteUrl)}</p>`;
  }
  return `<h1>Mentions légales</h1>
<h2>Éditeur du site</h2>
<p>Nom commercial : <span data-nexai-id="legal-nom">${echapper(c.nom)}</span><br>
Raison sociale : ${champ('raison-sociale', texte(b, 'raisonSociale'), 'raisonSociale')}<br>
Forme juridique : ${champ('forme', texte(b, 'formeJuridique'), 'formeJuridique')}<br>
Capital social : ${champ('capital', texte(b, 'capitalSocial'), 'capitalSocial')}<br>
Adresse du siège : ${champ('adresse', adresse, 'adresseSiege')}<br>
Immatriculation (RCCM, RCS ou équivalent) : ${champ('rcs', texte(b, 'numeroRCS', 'rccm'), 'numeroRCS')}<br>
E-mail : ${champ('email', email, 'emailContact')}<br>
Téléphone : ${champ('telephone', tel, 'telephoneContact')}</p>
<h2>Hébergement</h2>
<p>${HEBERGEUR.nom}, ${HEBERGEUR.adresse}.</p>
<h2>Adresse du site</h2>
<p>${echapper(c.siteUrl)}</p>`;
}

function corpsConfidentialite(c: Contexte): string {
  const { email, tel } = infosContact(c.brief);
  const b = c.brief;
  const contact = email || tel;
  if (c.en) {
    return `<h1>Privacy policy</h1>
<h2>Data controller</h2>
<p><span data-nexai-id="legal-nom-2">${echapper(c.nom)}</span> — contact: ${champ('contact-donnees', contact, 'emailContact')}</p>
<h2>Data collected and purpose</h2>
<p>The information you enter in the forms of this website (for example your name, phone number, e-mail address and message) is used only to answer your request or booking.</p>
<h2>Recipients</h2>
<p>The data is intended for the publisher of the website only. It is sent through and stored by its technical provider, NexAI, on the publisher’s behalf.</p>
<h2>Retention period</h2>
<p>${champ('duree', texte(b, 'dureeConservation'), 'dureeConservation')}</p>
<h2>Your rights</h2>
<p>You may access, correct or object to the use of your data, and ask for its deletion, by writing to: ${champ('contact-droits', contact, 'emailContact')}.</p>
<h2>Audience measurement</h2>
<p>This website counts its visits without cookies and without collecting personal data.</p>`;
  }
  return `<h1>Politique de confidentialité</h1>
<h2>Responsable du traitement</h2>
<p><span data-nexai-id="legal-nom-2">${echapper(c.nom)}</span> — contact : ${champ('contact-donnees', contact, 'emailContact')}</p>
<h2>Données collectées et finalité</h2>
<p>Les informations saisies dans les formulaires de ce site (par exemple nom, téléphone, adresse e-mail et message) servent uniquement à répondre à votre demande ou à votre réservation.</p>
<h2>Destinataires</h2>
<p>Les données sont destinées au seul éditeur du site. Elles sont transmises et conservées pour son compte par son prestataire technique, NexAI.</p>
<h2>Durée de conservation</h2>
<p>${champ('duree', texte(b, 'dureeConservation'), 'dureeConservation')}</p>
<h2>Vos droits</h2>
<p>Vous pouvez accéder à vos données, les faire rectifier, vous opposer à leur utilisation ou demander leur suppression en écrivant à : ${champ('contact-droits', contact, 'emailContact')}.</p>
<h2>Mesure d’audience</h2>
<p>Ce site compte ses visites sans cookie et sans collecter de donnée personnelle.</p>`;
}

function corpsCgv(c: Contexte): string {
  const conditions = texte(c.brief, 'cgv');
  const paragraphes = conditions
    .split(/\n{1,}/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => `<p data-nexai-id="legal-cgv-${i + 1}">${echapper(l)}</p>`)
    .join('\n');
  return c.en
    ? `<h1>Terms of sale</h1>\n<p>Seller: <span data-nexai-id="legal-nom-3">${echapper(c.nom)}</span></p>\n${paragraphes}`
    : `<h1>Conditions générales de vente</h1>\n<p>Vendeur : <span data-nexai-id="legal-nom-3">${echapper(c.nom)}</span></p>\n${paragraphes}`;
}

/** Premier élément <tag …>…</tag> (sans imbrication du même tag), ou ''. */
function premierBloc(html: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'i').exec(html);
  return m ? m[0] : '';
}
function dernierBloc(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi');
  let dernier = '';
  for (const m of html.matchAll(re)) dernier = m[0];
  return dernier;
}

/**
 * Construit une page légale à partir de l'accueil : même <head> (sans le
 * schema JSON-LD ni le préchargement de la photo), même en-tête, même pied
 * de page, mêmes scripts (protégés : un script de l'accueil qui cherche un
 * élément absent ne doit rien casser).
 */
function habiller(indexHtml: string, titre: string, corps: string, nomSite: string): string {
  const html = indexHtml;
  const ouvertureHtml = /<html\b[^>]*>/i.exec(html)?.[0] ?? '<html lang="fr">';
  let head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  head = head
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${echapper(`${titre} — ${nomSite}`)}</title>`)
    .replace(/<meta\b[^>]*name=["']description["'][^>]*>/i, () => `<meta name="description" content="${echapper(`${titre} — ${nomSite}`)}">`)
    .replace(/<meta\b[^>]*property=["']og:[^"']+["'][^>]*>/gi, '');
  head += `<meta name="robots" content="noindex, follow">
<style>.nx-legal{max-width:760px;margin:0 auto;padding:var(--section-y,64px) var(--gutter,16px)}
.nx-legal h1{font-family:var(--font-d);color:var(--ink);line-height:1.1;margin:0 0 .75em}
.nx-legal h2{font-family:var(--font-d);color:var(--ink);font-size:1.25rem;line-height:1.2;margin:2em 0 .5em}
.nx-legal p{color:var(--ink);line-height:1.6;margin:0 0 1em;overflow-wrap:anywhere}</style>`;
  // Les ancres de l'accueil (#reserver…) ramènent à l'accueil depuis une page légale.
  const versAccueil = (bloc: string) =>
    bloc.replace(/href=(["'])#(?!contenu\1)([^"']+)\1/gi, (_m, q: string, ancre: string) => `href=${q}index.html#${ancre}${q}`);
  const entete = versAccueil(premierBloc(html, 'header'));
  const pied = versAccueil(dernierBloc(html, 'footer'));
  const barre = versAccueil(/<nav\b[^>]*class=["'][^"']*\bbarre\b[^"']*["'][\s\S]*?<\/nav>/i.exec(html)?.[0] ?? '');
  const debutCorps = html.search(/<body\b/i);
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => debutCorps !== -1 && (m.index ?? 0) > debutCorps)
    .map((m) => `<script${m[1]}>try{${m[2]}\n}catch(e){}</script>`)
    .join('\n');
  return `<!doctype html>
${ouvertureHtml}
<head>${head}</head>
<body>
${entete}
<main id="contenu" class="nx-legal">
${corps}
</main>
${pied}
${barre}
<div style="display:none!important" aria-hidden="true"><form id="nx"></form></div>
${scripts}
</body>
</html>`;
}

export function construirePagesLegales(params: {
  indexHtml: string;
  brief: Record<string, unknown>;
  nomSite: string;
  siteUrl: string;
}): PageLegale[] {
  const lang = /<html\b[^>]*\blang=["']([a-z-]+)["']/i.exec(params.indexHtml)?.[1] ?? 'fr';
  const en = lang.toLowerCase().startsWith('en');
  const c: Contexte = { brief: params.brief, nom: params.nomSite, siteUrl: params.siteUrl, en };
  const pages: PageLegale[] = [
    { slug: 'mentions-legales', title: en ? 'Legal notice' : 'Mentions légales', html: corpsMentions(c) },
    { slug: 'confidentialite', title: en ? 'Privacy policy' : 'Politique de confidentialité', html: corpsConfidentialite(c) },
  ];
  if (texte(params.brief, 'cgv')) {
    pages.push({ slug: 'cgv', title: en ? 'Terms of sale' : 'Conditions générales de vente', html: corpsCgv(c) });
  }
  return pages.map((p) => ({ ...p, html: habiller(params.indexHtml, p.title, p.html, params.nomSite) }));
}
