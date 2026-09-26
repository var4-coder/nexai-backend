import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

/**
 * Remplissage et MISE À JOUR de la Librairie design NexAI, partagés entre :
 * - l'auto-seed au démarrage du serveur (autoSeedLibraryOnBoot, voir
 *   server.ts) ;
 * - la commande manuelle `npm run seed:library` (voir scripts/seed-library.ts)
 *   — remplacement complet, à n'utiliser que volontairement.
 *
 * Règle de mise à jour au démarrage, DOCUMENT PAR DOCUMENT :
 *   · document absent de la base            → ajouté ;
 *   · document modifié dans l'admin          → JAMAIS touché
 *     (`modifie_admin: true`, posé par l'onglet Librairie de l'admin) ;
 *   · document dont `seed_version` en base est plus ancienne que celle du
 *     fichier livré                          → remplacé par la version livrée ;
 *   · sinon                                  → laissé tel quel.
 * Avant, l'auto-seed ne remplissait que les collections VIDES : une mise à
 * jour de contenu livrée avec le code n'atteignait jamais une base déjà
 * remplie.
 *
 * Chemin des fichiers sources : seed-data/library/ à la racine du dépôt
 * (copié dans l'image Docker par `COPY . .`). On résout depuis
 * process.cwd() : Render lance toujours `npm start` depuis la racine.
 */

export const SEED_DIR = path.join(process.cwd(), 'seed-data', 'library');

export const LIBRARY_COLLECTIONS = [
  'library_niches',
  'library_palettes',
  'library_tokens',
  'library_components',
  'library_anti_slop',
  'library_copy',
  'library_rules',
  'library_judges',
  'library_layouts',
  'library_legal',
  'library_media',
  'library_seo',
  'library_contrast',
] as const;

export type LibraryCollection = (typeof LIBRARY_COLLECTIONS)[number];

export type LibraryDoc = { _id: string; seed_version?: number; modifie_admin?: boolean; [k: string]: unknown };

interface SeedResult {
  name: string;
  ajoutes: number;
  mis_a_jour: number;
  proteges: number;
  skipped: boolean;
  reason?: string;
}

/** Retire les clés commençant par « $ » (ex. « $schema »), refusées par MongoDB. */
function nettoyer(doc: LibraryDoc): LibraryDoc {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('$'))) as LibraryDoc;
}

/**
 * Lit les documents LIVRÉS d'une collection (fichier seed sur disque).
 * Sert aussi de copie de secours à library.service.ts quand Mongo ne répond
 * pas : c'est la même Librairie, pas une version parallèle.
 */
export function lireSeedLocal(name: string): LibraryDoc[] | null {
  const filePath = path.join(SEED_DIR, `${name}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const docs = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LibraryDoc[];
    return docs.map(nettoyer);
  } catch (e) {
    console.warn(`⚠️  Librairie : lecture du fichier livré « ${name} » impossible —`, (e as Error).message);
    return null;
  }
}

async function seedOneCollection(db: mongoose.mongo.Db, name: string): Promise<SeedResult> {
  const docs = lireSeedLocal(name);
  if (!docs) {
    return { name, ajoutes: 0, mis_a_jour: 0, proteges: 0, skipped: true, reason: 'fichier source introuvable' };
  }

  const collection = db.collection(name);
  let ajoutes = 0;
  let mis_a_jour = 0;
  let proteges = 0;

  for (const doc of docs) {
    const filtre = { _id: doc._id as unknown as mongoose.mongo.ObjectId };
    const existant = (await collection.findOne(filtre)) as LibraryDoc | null;

    if (!existant) {
      await collection.insertOne(doc as unknown as mongoose.mongo.OptionalId<mongoose.mongo.Document>);
      ajoutes++;
      continue;
    }
    if (existant.modifie_admin) {
      proteges++;
      continue;
    }
    if ((existant.seed_version ?? 0) < (doc.seed_version ?? 0)) {
      await collection.replaceOne(filtre, doc as unknown as mongoose.mongo.WithoutId<mongoose.mongo.Document>);
      mis_a_jour++;
    }
  }

  return { name, ajoutes, mis_a_jour, proteges, skipped: false };
}

async function replaceOneCollection(db: mongoose.mongo.Db, name: string): Promise<SeedResult> {
  const docs = lireSeedLocal(name);
  if (!docs) {
    return { name, ajoutes: 0, mis_a_jour: 0, proteges: 0, skipped: true, reason: 'fichier source introuvable' };
  }

  const collection = db.collection(name);

  // Remplacement PROPRE : on vide entièrement la collection avant d'insérer
  // le contenu livré. Écrase aussi les modifications faites dans l'admin —
  // c'est le but de cette commande manuelle.
  await collection.deleteMany({});
  if (docs.length > 0) {
    await collection.insertMany(docs as unknown as mongoose.mongo.OptionalUnlessRequiredId<mongoose.mongo.Document>[]);
  }

  return { name, ajoutes: docs.length, mis_a_jour: 0, proteges: 0, skipped: false };
}

/**
 * Remplacement complet — utilisé par `npm run seed:library`.
 * ATTENTION : écrase aussi les modifications faites depuis l'admin.
 */
export async function seedLibraryForce(db: mongoose.mongo.Db): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const name of LIBRARY_COLLECTIONS) {
    results.push(await replaceOneCollection(db, name));
  }
  return results;
}

/**
 * Auto-remplissage et mise à jour au démarrage du serveur (voir la règle en
 * tête de fichier). Ne bloque jamais le démarrage.
 */
export async function autoSeedLibraryOnBoot(): Promise<void> {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.warn('⚠️  Auto-seed Librairie ignoré : connexion Mongo indisponible.');
      return;
    }

    const results: SeedResult[] = [];
    for (const name of LIBRARY_COLLECTIONS) {
      // Une collection en échec ne bloque pas les suivantes.
      try {
        results.push(await seedOneCollection(db, name));
      } catch (e) {
        console.warn(`⚠️  Auto-seed Librairie : « ${name} » ignorée —`, (e as Error).message);
        results.push({ name, ajoutes: 0, mis_a_jour: 0, proteges: 0, skipped: true, reason: 'erreur' });
      }
    }

    const ajoutes = results.reduce((s, r) => s + r.ajoutes, 0);
    const misAJour = results.reduce((s, r) => s + r.mis_a_jour, 0);
    const proteges = results.reduce((s, r) => s + r.proteges, 0);
    const missingFiles = results.filter((r) => r.skipped && r.reason === 'fichier source introuvable');

    console.log(
      `📚 Librairie NexAI — ${ajoutes} document(s) ajouté(s), ${misAJour} mis à jour, ` +
        `${proteges} protégé(s) (modifiés dans l'admin).`
    );
    if (missingFiles.length > 0) {
      console.warn(
        `⚠️  Librairie NexAI — fichiers de seed manquants pour : ${missingFiles.map((r) => r.name).join(', ')}`
      );
    }
  } catch (err) {
    console.error('⚠️  Auto-seed Librairie échoué (non bloquant) :', err);
  }
}
