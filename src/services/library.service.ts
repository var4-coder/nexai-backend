import mongoose from 'mongoose';
import { loadInternalLibraryForNiche } from '@/data/library';

/**
 * Tirage librairie depuis Mongo (collections seedées), avec repli automatique sur la
 * librairie interne embarquée (src/data/library) en cas d'échec ou d'absence de données.
 *
 * Ordre de priorité, par niche :
 *   1. MongoDB (source de vérité principale, seedée manuellement)
 *   2. Librairie interne embarquée (second secours — mêmes 10 niches, mêmes 29 composants)
 *   3. Fallback générique minimal (dans libraryToCoderContext, dernier recours)
 *
 * Le repli se fait CHAMP PAR CHAMP (niche/tokens/palette/antiSlop/components/copy) et non
 * en tout-ou-rien : si Mongo répond mais qu'une seule collection est vide ou en échec
 * (ex : palette manquante pour une niche), seul ce champ bascule sur la librairie interne,
 * le reste continue d'utiliser les données Mongo réelles.
 */

async function loadLibraryFromMongo(niche: string) {
  const db = mongoose.connection.db;
  if (!db) {
    return null;
  }

  const [nicheDoc, tokens, palette, antiSlop, components, copy] = await Promise.all([
    // Les niches v3.1 utilisent `id` (pas `slug`) — on accepte les deux pour
    // rester compatible avec d'anciennes bases non re-seedées.
    db.collection('library_niches').findOne({ $or: [{ id: niche }, { slug: niche }] }),
    // Document unique, _id='global' dans la v3.1.
    db.collection('library_tokens').findOne({}),
    db.collection('library_palettes').findOne({ niche }),
    db.collection('library_anti_slop').findOne({}),
    // Composants pertinents pour CETTE niche uniquement + composants
    // universels (button, card, hero, nav, footer, form, section) qui ont un
    // tableau `niches` vide ou absent. Évite d'envoyer les 26 composants au
    // Codeur à chaque génération : ~9 pour un restaurant au lieu de 26, soit
    // une économie de tokens substantielle sur chaque appel.
    db.collection('library_components').find({
      $or: [
        { niches: niche },
        { niches: '*' },
        { niches: { $size: 0 } },
        { niches: { $exists: false } },
      ],
    }).toArray(),
    // library_copy est un document GLOBAL (règles de rédaction transverses),
    // pas un document par niche — les variantes par niche sont dans son
    // champ `structured.niches`.
    db.collection('library_copy').findOne({}),
  ]);

  // tokens may be stored with string _id
  let tokensDoc = tokens;
  if (!tokensDoc) {
    tokensDoc = await db.collection('library_tokens').findOne({});
  }

  return { niche: nicheDoc, tokens: tokensDoc, palette, antiSlop, components, copy };
}

export async function loadLibraryForNiche(niche: string) {
  let mongoResult: Awaited<ReturnType<typeof loadLibraryFromMongo>> = null;

  try {
    mongoResult = await loadLibraryFromMongo(niche);
  } catch (err) {
    console.error(
      `⚠️  Échec lecture librairie MongoDB pour la niche "${niche}" — bascule sur la librairie interne.`,
      err
    );
    mongoResult = null;
  }

  const internal = loadInternalLibraryForNiche(niche);

  // Repli champ par champ : on garde chaque donnée Mongo si présente, sinon on prend
  // l'équivalent de la librairie interne embarquée.
  const nicheDoc = mongoResult?.niche || internal.niche;
  const tokensDoc = mongoResult?.tokens || internal.tokens;
  const palette = mongoResult?.palette || internal.palette;
  const antiSlop = mongoResult?.antiSlop || internal.antiSlop;
  const copy = mongoResult?.copy || internal.copy;

  const mongoComponents = mongoResult?.components || [];
  const componentsSource: unknown[] = mongoComponents.length > 0 ? mongoComponents : internal.components;

  // Tirage aléatoire contrôlé : sous-ensemble de composants autorisés
  const allowedIds: string[] =
    (nicheDoc as { composants_autorises?: string[] } | null)?.composants_autorises || [];
  let pool: unknown[] = componentsSource;
  if (allowedIds.length) {
    // Les composants Mongo v3.1 utilisent `_id`, la librairie interne
    // embarquée utilise `id` — on accepte les deux pour que le filtrage
    // fonctionne quelle que soit la source réellement utilisée.
    pool = componentsSource.filter((c) => {
      const comp = c as { id?: string; _id?: string };
      const key = comp._id ?? comp.id;
      return key != null && allowedIds.includes(key);
    });
    // Si le filtre ne renvoie rien (composants Mongo mal alignés avec composants_autorises),
    // on retombe sur le pool interne déjà filtré pour cette niche plutôt que de livrer vide.
    if (pool.length === 0) {
      pool = internal.components;
    }
  }
  // Mélanger et prendre un sous-ensemble (max 12)
  pool = [...pool].sort(() => Math.random() - 0.5).slice(0, 12);

  return {
    niche: nicheDoc,
    tokens: tokensDoc,
    palette,
    antiSlop,
    components: pool,
    copy,
  };
}

export function libraryToCoderContext(lib: Awaited<ReturnType<typeof loadLibraryForNiche>>): string {
  if (!lib) {
    return 'Librairie Mongo indisponible — appliquer tokens WCAG et structure pro par défaut.';
  }
  const tokens = lib.tokens as
    | {
        primitive?: unknown;
        semantic?: unknown;
        component?: unknown;
        grid?: unknown;
        // Anciennes clés (librairie interne embarquée) — conservées pour que
        // le repli hors-ligne continue de fonctionner.
        a11y?: unknown;
        spacing_usage?: unknown;
        font_size?: unknown;
      }
    | null;

  return JSON.stringify(
    {
      niche: lib.niche,
      palette: lib.palette,
      // La v3.1 structure les tokens en primitive/semantic/component/grid.
      // On envoie ces blocs s'ils existent, sinon on retombe sur les clés de
      // l'ancienne librairie interne — jamais un objet vide silencieux.
      tokens_cles: tokens
        ? {
            primitive: tokens.primitive,
            semantic: tokens.semantic,
            component: tokens.component,
            grid: tokens.grid,
            a11y: tokens.a11y,
            spacing_usage: tokens.spacing_usage,
            font_size: tokens.font_size,
          }
        : null,
      composants_tires: (lib.components || []).map((c) => {
        // Mongo v3.1 → `_id` · librairie interne embarquée → `id`
        const comp = c as {
          id?: string;
          _id?: string;
          structure?: string;
          data_nexai_ids?: string[];
          content_md?: string;
        };
        return {
          id: comp._id ?? comp.id,
          structure: comp.structure,
          data_nexai_ids: comp.data_nexai_ids,
          // Recette complète du composant (anatomie, règles média,
          // anti-patterns) — c'est ce qui permet au Codeur de composer au
          // lieu d'inventer. Borné pour ne pas exploser le prompt.
          recette: comp.content_md ? comp.content_md.slice(0, 1800) : undefined,
        };
      }),
      copy: lib.copy,
      anti_slop: lib.antiSlop,
    },
    null,
    0
  );
}
