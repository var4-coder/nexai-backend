import { createApp } from '@/app';
import { env } from '@/config/env';
import { connectMongo } from '@/config/db';
import { redisConnection } from '@/config/redis';
import { autoSeedLibraryOnBoot } from '@/services/library-seed.service';

async function bootstrap() {
  await connectMongo();

  // Peuple automatiquement la Librairie design si les collections sont
  // vides (typiquement le tout premier déploiement) — ne touche à rien si
  // elle a déjà été initialisée ou modifiée à la main dans Mongo depuis.
  await autoSeedLibraryOnBoot();

  // Vérifie que Redis répond avant de démarrer (utilisé par BullMQ)
  await redisConnection.ping();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 NexAI backend démarré sur le port ${env.PORT} (${env.NODE_ENV})`);
  });

  // ── Mode mono-service (RUN_WORKER_IN_WEB=true) ──────────────────
  // Le worker tourne alors DANS le processus de l'API, au lieu d'un
  // service séparé. Pratique pour tester sans payer un second service,
  // mais à éviter en production réelle : une génération vidéo lourde
  // ralentit alors les requêtes HTTP, et un redémarrage de l'API
  // interrompt les traitements en cours.
  if (env.RUN_WORKER_IN_WEB) {
    console.log('⚙️  Mode mono-service : démarrage du worker dans ce processus');
    const { startWorker } = await import('@/jobs/worker');
    startWorker().catch((err) => {
      // Le worker ne doit jamais faire tomber l'API : on journalise et
      // l'API continue de répondre.
      console.error('❌ Worker intégré en échec', err);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} reçu — arrêt propre du serveur...`);
    server.close(() => {
      console.log('✅ Serveur HTTP fermé');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('❌ Échec du démarrage du backend', err);
  process.exit(1);
});
