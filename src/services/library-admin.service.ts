import mongoose from 'mongoose';
import { AppError } from '@/middleware/errorHandler';
import { LibrairieHistorique } from '@/models/LibrairieHistorique';
import {
  LIBRARY_COLLECTIONS,
  type LibraryCollection,
  type LibraryDoc,
  lireSeedLocal,
} from '@/services/library-seed.service';
import {
  chargerLibrairie,
  construireBlocCommun,
  construireBlocJugeVisuel,
  construireBlocJuges,
  construireBlocNiche,
  invaliderCacheLibrairie,
  NICHE_SITE_VERS_LIBRAIRIE,
} from '@/services/library.service';

/**
 * Onglet Admin → IA & qualité → Librairie.
 *
 * Tout ce que le codeur et les juges appliquent se lit et se modifie ici,
 * sans redéploiement. Garanties :
 *   · seules les 13 collections de la Librairie sont accessibles ;
 *   · chaque modification est historisée (contenu avant/après, auteur,
 *     commentaire) et peut être annulée — l'annulation est elle-même une
 *     nouvelle version ;
 *   · un document modifié ici est marqué `modifie_admin` : les mises à jour
 *     livrées avec le code ne l'écrasent jamais (voir library-seed.service) ;
 *   · « Revenir à la version livrée » retire cette marque : le document suit
 *     de nouveau les mises à jour livrées.
 * Prise en compte : immédiate côté serveur web ; le worker de génération
 * relit la Librairie au plus tard 1 minute après.
 */

export const LIBELLES_COLLECTIONS: Record<LibraryCollection, { label: string; desc: string }> = {
  library_rules: { label: 'Règles générales', desc: 'AI_RULES, règles de fabrication (M, H, R, PAY), performance, schema' },
  library_judges: { label: 'Juges', desc: 'Veto puis note /100, tests et barèmes' },
  library_niches: { label: 'Métiers (niches)', desc: 'Fiche de chaque métier : polices, couleurs, hero, ton, pages' },
  library_palettes: { label: 'Palettes', desc: 'Couleurs de chaque métier' },
  library_components: { label: 'Composants', desc: 'Recettes des blocs de page (hero, menu, avis…)' },
  library_copy: { label: 'Rédaction', desc: 'Titres, boutons, structures PAS/BAB, ton par métier' },
  library_anti_slop: { label: 'Anti « look IA »', desc: 'Ce qui rend un site générique : interdits et avertissements' },
  library_contrast: { label: 'Contrastes', desc: 'Paires de couleurs lisibles, ratios mesurés' },
  library_layouts: { label: 'Mises en page', desc: 'Hero par métier, ordre de page, pages minimales, mobile' },
  library_seo: { label: 'SEO', desc: 'Titres, descriptions, Open Graph, schema générique' },
  library_legal: { label: 'Mentions légales', desc: 'Pages et informations obligatoires' },
  library_media: { label: 'Médias', desc: 'Contraintes photo et vidéo' },
  library_tokens: { label: 'Tokens', desc: 'Espacements, tailles de texte, rayons, ombres' },
};

const CHAMPS_PROTEGES = new Set(['_id', 'seed_version', 'modifie_admin', 'modifie_le', 'modifie_par']);
const TAILLE_MAX_DOC = 200_000; // caractères, largement au-dessus du plus gros document livré

function verifierCollection(nom: string): LibraryCollection {
  if (!(LIBRARY_COLLECTIONS as readonly string[]).includes(nom)) {
    throw new AppError('Collection de Librairie inconnue.', 404);
  }
  return nom as LibraryCollection;
}

function db() {
  const d = mongoose.connection.db;
  if (!d) throw new AppError('Base de données indisponible, réessayez dans un instant.', 503);
  return d;
}

function titreDoc(d: LibraryDoc): string {
  return String(d.title ?? d.source_file ?? d.nom ?? d.id ?? d._id);
}

/** Comparaison indépendante de l'ordre des champs. */
function memeContenu(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v as object)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
        : JSON.stringify(v ?? null);
  return stable(a) === stable(b);
}

function nettoyerPourStockage(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('$')));
}

/** Vue d'ensemble : version, provenance, documents de chaque collection. */
export async function listerLibrairie() {
  const lib = await chargerLibrairie();
  const collections = LIBRARY_COLLECTIONS.map((nom) => ({
    nom,
    ...LIBELLES_COLLECTIONS[nom],
    provenance: lib.provenance[nom],
    documents: lib.docs[nom].map((d) => ({
      id: String(d._id),
      titre: titreDoc(d),
      modifieAdmin: d.modifie_admin === true,
      modifieLe: d.modifie_le ?? null,
      modifiePar: d.modifie_par ?? null,
      taille: JSON.stringify(d).length,
      aTexte: typeof d.content_md === 'string',
    })),
  }));
  return { version: lib.version, collections };
}

/** Un document complet + son historique (30 dernières versions). */
export async function lireDocumentLibrairie(collection: string, id: string) {
  const nom = verifierCollection(collection);
  const doc = (await db().collection(nom).findOne({ _id: id as unknown as mongoose.mongo.ObjectId })) as LibraryDoc | null;
  if (!doc) throw new AppError('Document introuvable.', 404);
  const livre = (lireSeedLocal(nom) ?? []).find((d) => String(d._id) === id) ?? null;
  const historique = await LibrairieHistorique.find({ collectionLib: nom, docId: id })
    .sort({ version: -1 })
    .limit(30)
    .select('version action auteur commentaire createdAt')
    .lean();
  return { collection: nom, document: doc, existeVersionLivree: !!livre, historique };
}

async function prochainNumero(nom: string, id: string): Promise<number> {
  const dernier = await LibrairieHistorique.findOne({ collectionLib: nom, docId: id }).sort({ version: -1 }).lean();
  return (dernier?.version ?? 0) + 1;
}

async function ecrire(
  nom: LibraryCollection,
  id: string,
  avant: LibraryDoc,
  nouveau: Record<string, unknown>,
  opts: { auteur: string; commentaire?: string; action: 'modification' | 'retour_arriere' | 'version_livree'; modifieAdmin: boolean }
) {
  const contenu: Record<string, unknown> = {
    ...nettoyerPourStockage(nouveau),
    seed_version: avant.seed_version ?? nouveau.seed_version ?? 0,
  };
  if (opts.modifieAdmin) {
    contenu.modifie_admin = true;
    contenu.modifie_le = new Date().toISOString();
    contenu.modifie_par = opts.auteur;
  }
  for (const k of ['_id']) delete contenu[k];

  const version = await prochainNumero(nom, id);
  await db()
    .collection(nom)
    .replaceOne({ _id: id as unknown as mongoose.mongo.ObjectId }, contenu as mongoose.mongo.WithoutId<mongoose.mongo.Document>);
  await LibrairieHistorique.create({
    collectionLib: nom,
    docId: id,
    version,
    action: opts.action,
    avant,
    apres: { _id: id, ...contenu },
    auteur: opts.auteur,
    commentaire: opts.commentaire?.slice(0, 500),
  });
  invaliderCacheLibrairie();
  const lib = await chargerLibrairie();
  return { version, versionLibrairie: lib.version };
}

/**
 * Modifie un document. `texte` remplace le texte (content_md) des documents
 * rédigés ; `donnees` remplace l'ensemble des autres champs (fiches métier,
 * palettes, tokens…). Les champs techniques ne sont jamais modifiables.
 */
export async function modifierDocumentLibrairie(
  collection: string,
  id: string,
  modif: { texte?: string; donnees?: Record<string, unknown> },
  auteur: string,
  commentaire?: string
) {
  const nom = verifierCollection(collection);
  const avant = (await db().collection(nom).findOne({ _id: id as unknown as mongoose.mongo.ObjectId })) as LibraryDoc | null;
  if (!avant) throw new AppError('Document introuvable.', 404);
  if (modif.texte === undefined && modif.donnees === undefined) {
    throw new AppError('Rien à enregistrer.', 400);
  }

  let nouveau: Record<string, unknown> = { ...avant };
  if (modif.donnees !== undefined) {
    if (!modif.donnees || typeof modif.donnees !== 'object' || Array.isArray(modif.donnees)) {
      throw new AppError('Les données doivent être un objet JSON.', 400);
    }
    const libres = Object.fromEntries(Object.entries(modif.donnees).filter(([k]) => !CHAMPS_PROTEGES.has(k)));
    const proteges = Object.fromEntries(Object.entries(avant).filter(([k]) => CHAMPS_PROTEGES.has(k)));
    nouveau = { ...proteges, ...libres };
  }
  if (modif.texte !== undefined) {
    if (typeof avant.content_md !== 'string' && typeof nouveau.content_md !== 'string') {
      throw new AppError('Ce document n’a pas de texte : modifiez ses données.', 400);
    }
    if (!modif.texte.trim()) throw new AppError('Le texte ne peut pas être vide.', 400);
    nouveau.content_md = modif.texte;
  }
  if (JSON.stringify(nouveau).length > TAILLE_MAX_DOC) {
    throw new AppError('Document trop long (200 000 caractères au maximum).', 400);
  }
  if (memeContenu(nettoyerPourStockage(nouveau), nettoyerPourStockage(avant))) {
    throw new AppError('Aucun changement par rapport à la version actuelle.', 400);
  }
  return ecrire(nom, id, avant, nouveau, { auteur, commentaire, action: 'modification', modifieAdmin: true });
}

/**
 * Remet le document tel qu'il était À la version donnée (contenu obtenu
 * juste après cette version). Version 0 = état d'origine, avant la toute
 * première modification faite dans l'admin. Le retour arrière crée une
 * nouvelle version : rien n'est effacé de l'historique.
 */
export async function retourArriereLibrairie(collection: string, id: string, version: number, auteur: string) {
  const nom = verifierCollection(collection);
  const cible =
    version === 0
      ? await LibrairieHistorique.findOne({ collectionLib: nom, docId: id }).sort({ version: 1 }).lean()
      : await LibrairieHistorique.findOne({ collectionLib: nom, docId: id, version }).lean();
  if (!cible) throw new AppError('Version introuvable.', 404);
  const contenu = (version === 0 ? cible.avant : cible.apres) as Record<string, unknown> | null;
  if (!contenu) throw new AppError('Contenu de cette version indisponible.', 404);
  const avant = (await db().collection(nom).findOne({ _id: id as unknown as mongoose.mongo.ObjectId })) as LibraryDoc | null;
  if (!avant) throw new AppError('Document introuvable.', 404);
  return ecrire(nom, id, avant, contenu, {
    auteur,
    commentaire: version === 0 ? "Retour à l'état d'origine" : `Retour à la version ${version}`,
    action: 'retour_arriere',
    modifieAdmin: true,
  });
}

/** Remet la version livrée avec le code ; le document suit de nouveau les mises à jour. */
export async function versionLivreeLibrairie(collection: string, id: string, auteur: string) {
  const nom = verifierCollection(collection);
  const livre = (lireSeedLocal(nom) ?? []).find((d) => String(d._id) === id);
  if (!livre) throw new AppError('Pas de version livrée pour ce document.', 404);
  const avant = (await db().collection(nom).findOne({ _id: id as unknown as mongoose.mongo.ObjectId })) as LibraryDoc | null;
  if (!avant) throw new AppError('Document introuvable.', 404);
  return ecrire(nom, id, avant, livre, {
    auteur,
    commentaire: 'Retour à la version livrée avec NexAI',
    action: 'version_livree',
    modifieAdmin: false,
  });
}

/**
 * Aperçu : ce que reçoivent réellement le codeur et les juges pour une niche,
 * avec la taille (≈ tokens) de chaque bloc.
 */
export async function apercuLibrairie(nicheSite: string) {
  if (!Object.keys(NICHE_SITE_VERS_LIBRAIRIE).includes(nicheSite)) {
    throw new AppError('Niche inconnue.', 400);
  }
  const lib = await chargerLibrairie();
  const commun = construireBlocCommun(lib);
  const niche = construireBlocNiche(lib, nicheSite);
  const juges = construireBlocJuges(lib);
  const visuel = construireBlocJugeVisuel(lib);
  const tokens = (s: string) => Math.round(s.length / 3.6);
  return {
    version: lib.version,
    ficheTrouvee: niche.ficheTrouvee,
    composants: niche.composants,
    blocs: [
      { nom: 'Bloc commun (codeur + juge code)', tokens: tokens(commun), texte: commun },
      { nom: `Bloc de la niche « ${niche.idNiche} » (codeur, juge code)`, tokens: tokens(niche.texte), texte: niche.texte },
      { nom: 'Règles des juges', tokens: tokens(juges), texte: juges },
      { nom: 'Règles du juge visuel', tokens: tokens(visuel), texte: visuel },
    ],
  };
}
