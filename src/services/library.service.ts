import crypto from 'crypto';
import mongoose from 'mongoose';
import { loadInternalLibraryForNiche } from '@/data/library';
import {
  LIBRARY_COLLECTIONS,
  LibraryCollection,
  LibraryDoc,
  lireSeedLocal,
} from '@/services/library-seed.service';

/**
 * Librairie design NexAI — SOURCE UNIQUE des règles de qualité.
 *
 * Le codeur, le juge code, le juge visuel, l'IA Aide et les pages
 * intérieures lisent tous le MÊME texte, assemblé ici :
 *
 *   · BLOC COMMUN  — identique pour tous les sites et toutes les niches
 *     (AI_RULES, REGLES_GENERATION, PERF, SCHEMA, tokens, CONTRAST, LAYOUTS,
 *     SLOP, COPY, SEO, LEGAL, MEDIA). Placé EN PREMIER pour être mis en
 *     cache par les fournisseurs (lecture facturée 5 à 25 % du prix).
 *   · BLOC NICHE   — fiche du métier, palette, composants et rédaction de
 *     la niche. Identique pour tous les sites d'une même niche : mis en
 *     cache lui aussi.
 *   · BLOC JUGES   — la manière de décider (veto puis note /100).
 *
 * Le code, lui, ne garde que le CONTRAT TECHNIQUE (format de sortie,
 * data-nexai-id, bouton de paiement, langue) : voir ia-pipeline.service.
 *
 * Provenance, collection par collection :
 *   1. MongoDB (source de vérité, modifiable depuis l'admin) ;
 *   2. dernière version lue avec succès en mémoire (Mongo en panne passagère) ;
 *   3. fichiers livrés seed-data/library (même contenu que la base au départ) ;
 *   4. librairie interne embarquée (dernier filet, niche/palette/composants).
 */

// ─── Correspondance des niches ────────────────────────────────────────────
//
// Les sites portent des identifiants longs (`restaurant_gastronomie`), la
// Librairie des identifiants courts (`restaurant`). Sans cette table, la
// fiche du métier et la palette n'étaient JAMAIS trouvées en base : le
// codeur recevait la librairie de secours, bien plus pauvre.
export const NICHE_SITE_VERS_LIBRAIRIE: Record<string, string> = {
  hotellerie_evenementiel: 'hotellerie',
  sante_bienetre: 'sante',
  immobilier_architecture: 'immobilier',
  services_locaux: 'services',
  business_vitrine: 'business',
  ecommerce_mode: 'mode',
  portfolio_creatif: 'portfolio',
  tech_startup_saas: 'saas',
  restaurant_gastronomie: 'restaurant',
  education_formation: 'education',
};

export function idNicheLibrairie(niche: string): string {
  return NICHE_SITE_VERS_LIBRAIRIE[niche] ?? niche;
}

/** Tags qui signifient « composant valable pour toutes les niches ». */
const TAGS_UNIVERSELS = new Set(['toutes', '*']);

// ─── Chargement ───────────────────────────────────────────────────────────

type Provenance = 'mongo' | 'memoire' | 'fichier' | 'vide';

export interface LibrairieComplete {
  docs: Record<LibraryCollection, LibraryDoc[]>;
  provenance: Record<LibraryCollection, Provenance>;
  /** Empreinte du contenu : change dès qu'une virgule change. */
  version: string;
}

const DUREE_MEMO_MS = 60_000;
let memo: { valeur: LibrairieComplete; expire: number } | null = null;
const derniereLectureMongo: Partial<Record<LibraryCollection, LibraryDoc[]>> = {};

/** À appeler après une modification de la Librairie (admin, seed). */
export function invaliderCacheLibrairie(): void {
  memo = null;
}

async function lireCollectionMongo(name: LibraryCollection): Promise<LibraryDoc[] | null> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) return null;
  const docs = (await db.collection(name).find({}).sort({ _id: 1 }).toArray()) as unknown as LibraryDoc[];
  return docs.length > 0 ? docs : null;
}

/** JSON à clés triées : même contenu → même texte → même empreinte. */
function jsonStable(valeur: unknown): string {
  if (Array.isArray(valeur)) return `[${valeur.map(jsonStable).join(',')}]`;
  if (valeur && typeof valeur === 'object') {
    const obj = valeur as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonStable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valeur ?? null);
}

export async function chargerLibrairie(): Promise<LibrairieComplete> {
  if (memo && memo.expire > Date.now()) return memo.valeur;

  const docs = {} as Record<LibraryCollection, LibraryDoc[]>;
  const provenance = {} as Record<LibraryCollection, Provenance>;

  for (const name of LIBRARY_COLLECTIONS) {
    let lus: LibraryDoc[] | null = null;
    try {
      lus = await lireCollectionMongo(name);
    } catch (err) {
      console.warn(`⚠️  Librairie : lecture Mongo « ${name} » impossible —`, (err as Error).message);
    }
    if (lus) {
      derniereLectureMongo[name] = lus;
      docs[name] = lus;
      provenance[name] = 'mongo';
      continue;
    }
    if (derniereLectureMongo[name]) {
      docs[name] = derniereLectureMongo[name]!;
      provenance[name] = 'memoire';
      continue;
    }
    const livres = lireSeedLocal(name);
    docs[name] = livres ?? [];
    provenance[name] = livres ? 'fichier' : 'vide';
  }

  const empreinte = crypto
    .createHash('sha256')
    .update(
      jsonStable(
        LIBRARY_COLLECTIONS.map((name) =>
          docs[name].map(({ modifie_admin: _m, modifie_le: _l, modifie_par: _p, ...reste }) => reste)
        )
      )
    )
    .digest('hex')
    .slice(0, 12);

  const valeur: LibrairieComplete = { docs, provenance, version: empreinte };
  memo = { valeur, expire: Date.now() + DUREE_MEMO_MS };

  const horsMongo = LIBRARY_COLLECTIONS.filter((n) => provenance[n] !== 'mongo');
  if (horsMongo.length > 0) {
    console.warn(
      `⚠️  Librairie : ${horsMongo.length} collection(s) hors Mongo (${horsMongo
        .map((n) => `${n}=${provenance[n]}`)
        .join(', ')})`
    );
  }
  return valeur;
}

/** Version courte de la Librairie (empreinte du contenu), enregistrée sur chaque site. */
export async function versionLibrairie(): Promise<string> {
  return (await chargerLibrairie()).version;
}

// ─── Assemblage des blocs ─────────────────────────────────────────────────

function doc(lib: LibrairieComplete, coll: LibraryCollection, id: string): LibraryDoc | undefined {
  return lib.docs[coll].find((d) => String(d._id) === id || d.id === id);
}

/** Retire les champs techniques de la base avant de montrer un document à une IA. */
function sansMeta(d: LibraryDoc | undefined): Record<string, unknown> | null {
  if (!d) return null;
  const {
    _id: _i,
    seed_version: _s,
    modifie_admin: _m,
    modifie_le: _l,
    modifie_par: _p,
    source_file: _f,
    ...reste
  } = d;
  return reste;
}

function section(titre: string, contenu: string | undefined | null): string {
  const texte = (contenu ?? '').trim();
  return texte ? `\n\n══════ ${titre} ══════\n${texte}` : '';
}

function md(lib: LibrairieComplete, coll: LibraryCollection, id: string): string | undefined {
  const d = doc(lib, coll, id) ?? lib.docs[coll][0];
  return typeof d?.content_md === 'string' ? d.content_md : undefined;
}


// ─── Lignes propres à un métier ─────────────────────────────────────────
//
// Plusieurs règles de la Librairie contiennent des tableaux « une ligne par
// niche » (contrastes, hero, offre, ton, schema…). Envoyer les 10 lignes à
// chaque site fait payer au codeur les règles des 9 autres métiers. On les
// retire du bloc commun et chaque niche reçoit SES lignes dans sa fiche : le
// contenu reste le même, seule sa place change.

const IDS_NICHES_LIBRAIRIE = new Set(Object.values(NICHE_SITE_VERS_LIBRAIRIE));

function nichesDeLaCellule(cellule: string): string[] {
  return cellule
    .replace(/[`*]/g, '')
    .split(/[\/,+]| et /)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => IDS_NICHES_LIBRAIRIE.has(x));
}

/**
 * Sépare un document Markdown en partie commune + lignes par niche.
 * Une ligne de tableau dont la 1re cellule désigne une ou plusieurs niches
 * part dans la fiche de ces niches (avec l'en-tête de son tableau et le
 * titre de sa section). La section « Banque d'exemples » de COPY.md (un
 * exemple par niche) est retirée : l'exemple de la niche est déjà dans la
 * rédaction propre à la niche.
 */
export function separerParNiche(markdown: string): { commun: string; parNiche: Record<string, string> } {
  const lignes = markdown.split('\n');
  const commun: string[] = [];
  const parNiche: Record<string, string[]> = {};
  let titre = '';
  let entete: string[] = [];
  let retireeDuTableau = false;
  let dansBanque = false;

  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (/^#{1,3} /.test(l)) {
      titre = l.replace(/^#+ /, '');
      dansBanque = /banque d'exemples/i.test(l);
      entete = [];
      retireeDuTableau = false;
      if (dansBanque) continue;
    }
    if (dansBanque) continue;

    if (l.trim().startsWith('|')) {
      const cellules = l.split('|').slice(1, -1).map((c) => c.trim());
      const estSeparateur = cellules.every((c) => /^:?-{2,}:?$/.test(c));
      if (entete.length < 2 && (entete.length === 0 || estSeparateur)) {
        entete.push(l);
        commun.push(l);
        continue;
      }
      const niches = nichesDeLaCellule(cellules[0] ?? '');
      if (niches.length > 0) {
        for (const n of niches) {
          parNiche[n] ??= [];
          const cle = `${titre}\u0000${entete[0]}`;
          if (!parNiche[n].includes(`@@${cle}`)) {
            parNiche[n].push(`@@${cle}`, `(${titre})`, ...entete);
          }
          parNiche[n].push(l);
        }
        if (!retireeDuTableau) {
          commun.push('| … | lignes propres à chaque métier : voir la FICHE DE LA NICHE |');
          retireeDuTableau = true;
        }
        continue;
      }
      commun.push(l);
      continue;
    }
    entete = [];
    retireeDuTableau = false;
    commun.push(l);
  }

  const sortie: Record<string, string> = {};
  for (const [n, ls] of Object.entries(parNiche)) {
    sortie[n] = ls.filter((x) => !x.startsWith('@@')).join('\n').replace(/\n\(/g, '\n\n(');
  }
  return { commun: commun.join('\n'), parNiche: sortie };
}

/** Documents Markdown du bloc commun, dans l'ordre d'envoi. */
const DOCS_COMMUNS: Array<[string, LibraryCollection, string]> = [
  ['AI_RULES.md', 'library_rules', 'ai_rules'],
  ['REGLES_GENERATION.md', 'library_rules', 'regles_generation'],
  ['PERF.md', 'library_rules', 'perf'],
  ['SCHEMA.md', 'library_rules', 'schema'],
  ['CONTRAST.md', 'library_contrast', 'contrast'],
  ['LAYOUTS.md', 'library_layouts', 'layouts'],
  ['SLOP.md', 'library_anti_slop', 'slop'],
  ['COPY.md', 'library_copy', 'copy'],
  ['SEO.md', 'library_seo', 'seo'],
  ['LEGAL.md', 'library_legal', 'legal'],
  ['MEDIA.md', 'library_media', 'media'],
];

function mdCommun(lib: LibrairieComplete, coll: LibraryCollection, id: string): string | undefined {
  const texte = md(lib, coll, id);
  return texte === undefined ? undefined : separerParNiche(texte).commun;
}

/** Lignes des tableaux « par niche » de toute la Librairie, pour UNE niche. */
function reglesPropresALaNiche(lib: LibrairieComplete, idNiche: string): string {
  return DOCS_COMMUNS.map(([nom, coll, id]) => {
    const texte = md(lib, coll, id);
    const lignes = texte ? separerParNiche(texte).parNiche[idNiche] : undefined;
    return lignes ? `[${nom}]\n${lignes}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * BLOC COMMUN — identique pour tous les sites. Ne doit JAMAIS contenir
 * d'élément propre à un site ou à une niche : le moindre caractère différent
 * casserait la mise en cache.
 */
export function construireBlocCommun(lib: LibrairieComplete): string {
  const tokens = doc(lib, 'library_tokens', 'global') ?? lib.docs.library_tokens[0];
  // css_raw contient déjà les variables : on n'y ajoute que ce qu'il ne dit
  // pas (échelle typographique, composants, grille, médias), sans répéter
  // les valeurs primitives.
  const tokensTexte = tokens
    ? [
        typeof tokens.css_raw === 'string' ? tokens.css_raw : '',
        JSON.stringify({
          meta: tokens.meta,
          type: (tokens.primitive as { type?: unknown } | undefined)?.type,
          component: tokens.component,
          grid: tokens.grid,
          icon: tokens.icon,
          media: tokens.media,
        }),
      ].join('\n')
    : '';

  return (
    `LIBRAIRIE DESIGN NEXAI — version ${lib.version}\n` +
    'Règles communes au codeur et aux juges. Chaque règle numérotée (M1, C1, S3, PAY1…) ' +
    'est citée par son numéro dans les verdicts.' +
    DOCS_COMMUNS.slice(0, 4)
      .map(([nom, coll, id]) => section(nom, mdCommun(lib, coll, id)))
      .join('') +
    section('TOKENS (global)', tokensTexte) +
    DOCS_COMMUNS.slice(4)
      .map(([nom, coll, id]) => section(nom, mdCommun(lib, coll, id)))
      .join('')
  );
}

/** Composants de la niche : universels + propres au métier, ordre stable. */
function composantsDeLaNiche(lib: LibrairieComplete, idNiche: string): LibraryDoc[] {
  return lib.docs.library_components.filter((c) => {
    const niches = Array.isArray(c.niches) ? (c.niches as string[]) : [];
    return niches.length === 0 || niches.includes(idNiche) || niches.some((n) => TAGS_UNIVERSELS.has(n));
  });
}

export interface BlocNiche {
  idNiche: string;
  texte: string;
  /** Identifiants des composants fournis (relance en variation, Fable). */
  composants: string[];
  /** true si la fiche métier vient bien de la Librairie (pas du dernier filet). */
  ficheTrouvee: boolean;
  /**
   * Fiche métier + palette + rédaction, SANS les recettes de composants :
   * c'est tout ce dont le juge visuel a besoin pour juger un rendu.
   */
  texteFiche: string;
}

/**
 * BLOC NICHE — identique pour tous les sites d'une même niche (mis en cache
 * lui aussi). La variété entre deux clients vient du brief, de la seed de
 * direction artistique et, à venir, des variantes de hero / palettes /
 * polices choisies selon le brief.
 */
export function construireBlocNiche(lib: LibrairieComplete, nicheSite: string): BlocNiche {
  const idNiche = idNicheLibrairie(nicheSite);
  const fiche = doc(lib, 'library_niches', idNiche);
  const palette = lib.docs.library_palettes.find((p) => p.niche === idNiche || String(p._id) === idNiche);
  const copy = doc(lib, 'library_copy', 'copy') ?? lib.docs.library_copy[0];
  const redactionNiche = (
    (copy?.structured as { niches?: Array<{ id?: string }> } | undefined)?.niches ?? []
  ).find((n) => n.id === idNiche);

  let composants = composantsDeLaNiche(lib, idNiche);
  let ficheTexte = fiche ? JSON.stringify(sansMeta(fiche)) : '';
  let paletteTexte = palette ? JSON.stringify(sansMeta(palette)) : '';

  // Dernier filet : librairie interne embarquée (niche inconnue de la
  // Librairie ou base et fichiers illisibles).
  if (!fiche || composants.length === 0) {
    const interne = loadInternalLibraryForNiche(nicheSite);
    if (!fiche && interne.niche) ficheTexte = JSON.stringify(interne.niche);
    if (!palette && interne.palette) paletteTexte = JSON.stringify(interne.palette);
    if (composants.length === 0) {
      composants = interne.components.map((c) => ({ ...(c as unknown as LibraryDoc), _id: (c as { id: string }).id }));
    }
  }

  const composantsTexte = composants
    .map((c) => {
      const titre = `${String(c._id)}${c.title ? ` — ${String(c.title)}` : ''}`;
      const corps =
        typeof c.content_md === 'string'
          ? c.content_md
          : JSON.stringify(sansMeta(c));
      return `### ${titre}\n${corps}`;
    })
    .join('\n\n');

  const texteFiche =
    `FICHE DE LA NICHE « ${idNiche} » (site : ${nicheSite})` +
    section('FICHE MÉTIER (niches/' + idNiche + '.json)', ficheTexte) +
    section('PALETTE DE LA NICHE', paletteTexte) +
    section('RÉDACTION PROPRE À LA NICHE', redactionNiche ? JSON.stringify(redactionNiche) : '') +
    section('RÈGLES PROPRES À LA NICHE (lignes des tableaux de la Librairie)', reglesPropresALaNiche(lib, idNiche));
  const texte =
    texteFiche +
    section('COMPOSANTS AUTORISÉS (recettes à composer, ne rien inventer hors de cette liste)', composantsTexte);

  return {
    idNiche,
    texte,
    texteFiche,
    composants: composants.map((c) => String(c._id)),
    ficheTrouvee: !!fiche,
  };
}

/** BLOC JUGES — comment décider (veto puis note /100). Identique pour tous. */
export function construireBlocJuges(lib: LibrairieComplete): string {
  return section('JUDGES.md', md(lib, 'library_judges', 'judges')).trim();
}

/**
 * BLOC DU JUGE VISUEL — sous-ensemble de la même Librairie : ce qui se VOIT
 * sur une capture (tests V1–V10 et barème de JUDGES.md, SLOP.md, LAYOUTS.md,
 * règles M et PAY). Les règles de code (tokens, schema, SEO, performance…)
 * sont jugées par le juge code : les renvoyer au juge visuel, facturé au
 * prix d'un grand modèle, coûterait ~12 000 tokens par jugement pour rien.
 */
export function construireBlocJugeVisuel(lib: LibrairieComplete): string {
  return (
    `LIBRAIRIE DESIGN NEXAI — version ${lib.version} — règles visuelles` +
    section('REGLES_GENERATION.md', mdCommun(lib, 'library_rules', 'regles_generation')) +
    section('LAYOUTS.md', mdCommun(lib, 'library_layouts', 'layouts')) +
    section('SLOP.md', mdCommun(lib, 'library_anti_slop', 'slop')) +
    section('JUDGES.md', md(lib, 'library_judges', 'judges'))
  );
}

// ─── Compatibilité ────────────────────────────────────────────────────────

/**
 * Accès simplifié par niche (utilisé par la relance en variation de Fable).
 */
export async function loadLibraryForNiche(niche: string) {
  const lib = await chargerLibrairie();
  const bloc = construireBlocNiche(lib, niche);
  return {
    version: lib.version,
    idNiche: bloc.idNiche,
    components: bloc.composants.map((id) => ({ _id: id })),
    blocNiche: bloc.texte,
  };
}
