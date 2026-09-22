/**
 * Seed FORCÉ de la Librairie design NexAI (v3.1) dans MongoDB.
 *
 * Usage : npm run seed:library
 *
 * À utiliser volontairement quand une mise à jour de contenu de la
 * Librairie doit être appliquée (écrase le contenu existant par upsert).
 * Au tout premier déploiement, ce n'est pas nécessaire : le serveur
 * peuple automatiquement la Librairie tout seul au démarrage si les
 * collections sont vides (voir autoSeedLibraryOnBoot dans server.ts).
 */
import mongoose from 'mongoose';
import 'dotenv/config';
import { seedLibraryForce, LIBRARY_COLLECTIONS } from '../src/services/library-seed.service';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI manquant dans les variables d'environnement.");
    process.exit(1);
  }

  console.log('Connexion à MongoDB...');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  console.log(`Seed forcé de ${LIBRARY_COLLECTIONS.length} collections...\n`);

  const results = await seedLibraryForce(db);

  for (const r of results) {
    if (r.skipped) {
      console.log(`⚠️  ${r.name} — ${r.reason}`);
    } else {
      console.log(`✔ ${r.name} — ${r.count} document(s)`);
    }
  }

  const total = results.reduce((sum, r) => sum + r.count, 0);
  console.log(`\nTerminé — ${total} documents écrits au total.`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erreur durant le seed :', err);
  process.exit(1);
});
