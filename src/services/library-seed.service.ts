import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

/**
 * Logique de seed de la Librairie design NexAI, partagée entre :
 * - l'auto-seed au démarrage du serveur (autoSeedLibraryOnBoot, voir
 *   server.ts) — ne seed QUE si les collections sont vides, pour ne
 *   jamais écraser une modification faite à la main dans Mongo ;
 * - la commande manuelle `npm run seed:library` (voir scripts/seed-library.ts)
 *   — force toujours le remplacement (upsert), utilisée quand on livre une
 *   vraie mise à jour de contenu de la Librairie.
 *
 * Chemin des fichiers sources : seed-data/library/ à la racine du dépôt.
 * On résout depuis process.cwd() plutôt que __dirname pour rester correct
 * qu'on tourne en dev (tsx, depuis src/) ou en prod (node, depuis dist/) —
 * Render lance toujours `npm start` depuis la racine du dépôt.
 */

const SEED_DIR = path.join(process.cwd(), 'seed-data', 'library');

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

interface SeedResult {
  name: string;
  count: number;
  skipped: boolean;
  reason?: string;
}

async function seedOneCollection(db: mongoose.mongo.Db, name: string): Promise<SeedResult> {
  const filePath = path.join(SEED_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    return { name, count: 0, skipped: true, reason: 'fichier source introuvable' };
  }

  const collection = db.collection(name);

  // Auto-seed : ne touche JAMAIS une collection déjà peuplée, pour ne
  // jamais écraser une modification faite à la main dans Mongo.
  const existing = await collection.countDocuments();
  if (existing > 0) {
    return { name, count: existing, skipped: true, reason: 'déjà peuplée, non modifiée' };
  }

  const docs: Array<{ _id: string; [k: string]: unknown }> = JSON.parse(
    fs.readFileSync(filePath, 'utf-8')
  );

  let count = 0;
  for (const doc of docs) {
    const { _id, ...rest } = doc;
    await collection.updateOne(
      { _id: _id as unknown as mongoose.mongo.ObjectId },
      { $set: rest },
      { upsert: true }
    );
    count++;
  }
  return { name, count, skipped: false };
}

async function replaceOneCollection(db: mongoose.mongo.Db, name: string): Promise<SeedResult> {
  const filePath = path.join(SEED_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    return { name, count: 0, skipped: true, reason: 'fichier source introuvable' };
  }

  const docs: Array<{ _id: string; [k: string]: unknown }> = JSON.parse(
    fs.readFileSync(filePath, 'utf-8')
  );

  const collection = db.collection(name);

  // Remplacement PROPRE : on vide entièrement la collection avant d'insérer
  // le nouveau contenu, plutôt qu'un simple upsert par _id. Un upsert seul
  // laisserait des documents orphelins si l'ancienne Librairie avait des
  // identifiants différents (ex. plus de niches qu'aujourd'hui) — ici, la
  // collection correspond exactement au nouveau contenu, rien de plus.
  await collection.deleteMany({});
  if (docs.length > 0) {
    await collection.insertMany(docs as unknown as mongoose.mongo.OptionalUnlessRequiredId<mongoose.mongo.Document>[]);
  }

  return { name, count: docs.length, skipped: false };
}

/**
 * Remplacement complet et propre — utilisé par `npm run seed:library`.
 * Vide chaque collection puis insère le contenu de la nouvelle Librairie :
 * garantit qu'aucun document d'une ancienne version ne subsiste, même si
 * les identifiants ont changé entre-temps (ex. changement du nombre de
 * niches). À utiliser volontairement, quand on pousse une mise à jour du
 * contenu de la Librairie.
 */
export async function seedLibraryForce(db: mongoose.mongo.Db): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const name of LIBRARY_COLLECTIONS) {
    results.push(await replaceOneCollection(db, name));
  }
  return results;
}

/**
 * Auto-seed au démarrage du serveur — ne fait RIEN si au moins une
 * collection de la Librairie contient déjà des documents (on considère
 * alors que la Librairie a déjà été initialisée, potentiellement modifiée
 * à la main depuis, et on ne touche à rien). Ne seed que les collections
 * réellement vides, typiquement au tout premier déploiement.
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
      results.push(await seedOneCollection(db, name));
    }

    const seeded = results.filter((r) => !r.skipped);
    const alreadyPresent = results.filter((r) => r.skipped && r.reason === 'déjà peuplée, non modifiée');
    const missingFiles = results.filter((r) => r.skipped && r.reason === 'fichier source introuvable');

    if (seeded.length > 0) {
      const total = seeded.reduce((s, r) => s + r.count, 0);
      console.log(
        `📚 Librairie NexAI — auto-seed initial : ${seeded.length} collection(s) créée(s), ${total} document(s) au total.`
      );
    }
    if (alreadyPresent.length === LIBRARY_COLLECTIONS.length) {
      console.log('📚 Librairie NexAI — déjà initialisée, aucune modification (auto-seed ignoré).');
    }
    if (missingFiles.length > 0) {
      console.warn(
        `⚠️  Librairie NexAI — fichiers de seed manquants pour : ${missingFiles.map((r) => r.name).join(', ')}`
      );
    }
  } catch (err) {
    // Ne bloque jamais le démarrage du serveur pour un souci d'auto-seed —
    // au pire la Librairie retombe sur le repli embarqué (library.service.ts).
    console.error('⚠️  Auto-seed Librairie échoué (non bloquant) :', err);
  }
}
