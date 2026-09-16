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

  // ── Mode mono-service (défaut : RUN_WORKER_IN_WEB=true) ─────────
  // Plan free Render : pas de Background Worker → API + worker dans
  // le même process. Plus tard, service Worker dédié + RUN_WORKER_IN_WEB=false.
  if (env.RUN_WORKER_IN_WEB) {
    console.log('⚙️  Mode mono-service (API + worker) — adapté plan free Render');
    const { startWorker } = await import('@/jobs/worker');
    startWorker().catch((err) => {
      // Le worker ne doit jamais faire tomber l'API : on journalise et
      // l'API continue de répondre.
      console.error('❌ Worker intégré en échec', err);
    });
  } else {
    console.log(
      'ℹ️  RUN_WORKER_IN_WEB=false — démarrez un service Worker séparé (node dist/jobs/worker.js)'
    );
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
