"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const mongoose_1 = __importDefault(require("mongoose"));
require("dotenv/config");
const library_seed_service_1 = require("../src/services/library-seed.service");
async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("❌ MONGODB_URI manquant dans les variables d'environnement.");
        process.exit(1);
    }
    console.log('Connexion à MongoDB...');
    await mongoose_1.default.connect(uri);
    const db = mongoose_1.default.connection.db;
    console.log(`Seed forcé de ${library_seed_service_1.LIBRARY_COLLECTIONS.length} collections...\n`);
    const results = await (0, library_seed_service_1.seedLibraryForce)(db);
    for (const r of results) {
        if (r.skipped) {
            console.log(`⚠️  ${r.name} — ${r.reason}`);
        }
        else {
            console.log(`✔ ${r.name} — ${r.count} document(s)`);
        }
    }
    const total = results.reduce((sum, r) => sum + r.count, 0);
    console.log(`\nTerminé — ${total} documents écrits au total.`);
    await mongoose_1.default.disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error('❌ Erreur durant le seed :', err);
    process.exit(1);
});
//# sourceMappingURL=seed-library.js.map