/**
 * Édition directe des textes d'un site.
 *
 * Le client voit la liste des textes de sa page, les modifie, et enregistre.
 * Aucune IA n'intervient : c'est une simple substitution de chaînes, donc
 * GRATUITE pour lui et sans coût fournisseur pour NexAI.
 *
 * L'ancien bouton « Modifier textes » n'écrivait rien dans le site : il
 * enregistrait une description dans le brief, que le client croyait
 * appliquée. Rien ne changeait sur sa page.
 *
 * Volontairement sans bibliothèque d'analyse HTML : on ne reconstruit jamais
 * le document — on remplace le contenu de balises repérées à leur position
 * exacte. Le reste du HTML, y compris les styles et les scripts, est
 * rigoureusement préservé.
 */

/** Balises dont le texte est proposé à l'édition. */
const BALISES_EDITABLES = [
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'li',
  'a',
  'button',
  'span',
  'strong',
  'em',
  'blockquote',
  'figcaption',
  'label',
];

export interface TexteEditable {
  /** Position du texte dans la page — sert de clé au réenregistrement. */
  id: string;
  /** Balise d'origine, pour que le client situe le texte. */
  balise: string;
  /** Texte affiché. */
  texte: string;
}

/** Contenus à ignorer : ce ne sont pas des textes visibles éditables. */
function ignorable(texte: string): boolean {
  const t = texte.trim();
  if (t.length < 2 || t.length > 600) return true;
  // Entités HTML seules (&nbsp;, &amp;…), variables de gabarit, ou contenu
  // sans aucune lettre : rien d'éditable pour le client.
  const sansEntites = t.replace(/&[a-z]+;|&#\d+;/gi, '').trim();
  if (sansEntites.length < 2) return true;
  if (/^[\s{}()[\]<>/\\|=+*-]+$/.test(sansEntites)) return true;
  if (!/[a-zA-ZÀ-ÿ]/.test(sansEntites)) return true;
  return false;
}

/**
 * Liste les textes modifiables d'une page.
 *
 * Seules les balises SANS balise imbriquée sont retenues : éditer un
 * paragraphe qui contient un lien écraserait ce lien. On ne propose donc que
 * les feuilles de l'arbre, là où le texte est réellement seul.
 */
export function listerTextesEditables(html: string): TexteEditable[] {
  const resultats: TexteEditable[] = [];
  const motif = new RegExp(
    `<(${BALISES_EDITABLES.join('|')})\\b[^>]*>([^<]*)</\\1>`,
    'gi'
  );

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = motif.exec(html)) !== null) {
    const balise = m[1].toLowerCase();
    const texte = m[2];
    if (ignorable(texte)) continue;
    resultats.push({ id: `t${index}`, balise, texte: texte.trim() });
    index += 1;
  }
  return resultats;
}

/**
 * Applique les textes modifiés au HTML.
 *
 * Le repérage suit EXACTEMENT le même parcours que la lecture : même motif,
 * même ordre. Un texte non fourni reste inchangé.
 *
 * Le contenu est échappé avant insertion : un client qui taperait un chevron
 * ou une balise ne doit pas pouvoir casser sa page, ni y injecter de script.
 */
export function appliquerTextes(html: string, modifications: Record<string, string>): string {
  const motif = new RegExp(
    `<(${BALISES_EDITABLES.join('|')})\\b[^>]*>([^<]*)</\\1>`,
    'gi'
  );

  let index = 0;
  return html.replace(motif, (entier, balise: string, texte: string) => {
    if (ignorable(texte)) return entier;
    const cle = `t${index}`;
    index += 1;

    const nouveau = modifications[cle];
    if (typeof nouveau !== 'string' || nouveau.trim() === texte.trim()) return entier;

    const propre = echapper(nouveau.slice(0, 600));
    // On remplace UNIQUEMENT le contenu, en gardant la balise ouvrante
    // telle quelle — ses classes et attributs sont préservés.
    const ouvrante = entier.slice(0, entier.indexOf('>') + 1);
    return `${ouvrante}${propre}</${balise}>`;
  });
}

function echapper(texte: string): string {
  return texte
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Renvoie la page avec un repère sur chaque texte modifiable.
 *
 * Indispensable à l'édition en direct : l'éditeur affiche la VRAIE page dans
 * un cadre, et doit savoir quel texte correspond à quel identifiant. Le
 * repérage se fait donc ici, avec exactement le même parcours que la lecture
 * et l'écriture — les identifiants ne peuvent pas diverger.
 */
export function baliserTextesEditables(html: string): string {
  const motif = new RegExp(`<(${BALISES_EDITABLES.join('|')})\\b[^>]*>([^<]*)</\\1>`, 'gi');
  let index = 0;
  return html.replace(motif, (entier, _balise: string, texte: string) => {
    if (ignorable(texte)) return entier;
    const cle = `t${index}`;
    index += 1;
    // Le repère est ajouté à la balise ouvrante, sans rien déplacer.
    const finOuvrante = entier.indexOf('>');
    const ouvrante = entier.slice(0, finOuvrante);
    return `${ouvrante} data-nexai-edit="${cle}"${entier.slice(finOuvrante)}`;
  });
}
