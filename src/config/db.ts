import mongoose from 'mongoose';
import { env } from './env';

mongoose.set('strictQuery', true);

/**
 * Connexion à la base MongoDB de la PLATEFORME NexAI (users, sites, jobs,
 * credits, academy, boutique, paiements Chariow...).
 *
 * Les données runtime des sites livrés aux clients (fiche de config créée au
 * lancement, soumissions de formulaires/réservations) vivent dans des
 * collections dédiées du même cluster Mongo — SiteRuntime et SiteSubmission
 * — volontairement séparées des collections métier ci-dessus, mais sans
 * dépendance à un service externe (voir services/site-runtime.service.ts et
 * routes/public.routes.ts).
 */
export async function connectMongo(): Promise<void> {
  const MAX_RETRIES = 5;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await mongoose.connect(env.MONGODB_URI);
      console.log('✅ MongoDB connecté');
      return;
    } catch (err) {
      attempt += 1;
      const delayMs = attempt * 2000;
      console.error(`❌ Échec connexion MongoDB (tentative ${attempt}/${MAX_RETRIES}). Nouvelle tentative dans ${delayMs}ms...`, err);
      if (attempt >= MAX_RETRIES) {
        throw new Error('Impossible de se connecter à MongoDB après plusieurs tentatives');
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB déconnecté');
});

export { mongoose };
