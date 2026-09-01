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
    db.collection('library_niches').findOne({ slug: niche }),
    db.collection('library_tokens').findOne({ _id: 'tokens_globaux' as unknown as mongoose.Types.ObjectId }),
    db.collection('library_palettes').findOne({ niche }),
    db.collection('library_anti_slop').findOne({}),
    db.collection('library_components').find({
      $or: [{ niches: '*' }, { niches: niche }],
    }).toArray(),
    db.collection('library_copy').findOne({ niche }),
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
    pool = componentsSource.filter((c) => allowedIds.includes((c as unknown as { id: string }).id));
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
  return JSON.stringify(
    {
      niche: lib.niche,
      palette: lib.palette,
      tokens_cles: lib.tokens
        ? {
            a11y: (lib.tokens as { a11y?: unknown }).a11y,
            spacing_usage: (lib.tokens as { spacing_usage?: unknown }).spacing_usage,
            font_size: (lib.tokens as { font_size?: unknown }).font_size,
          }
        : null,
      composants_tires: (lib.components || []).map((c) => ({
        id: (c as unknown as { id: string }).id,
        structure: (c as unknown as { structure?: string }).structure,
        data_nexai_ids: (c as unknown as { data_nexai_ids?: string[] }).data_nexai_ids,
      })),
      copy: lib.copy,
      anti_slop: lib.antiSlop,
    },
    null,
    0
  );
}
