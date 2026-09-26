import { createApp } from '@/app';
import { env } from '@/config/env';
import { connectMongo } from '@/config/db';
import { redisConnection } from '@/config/redis';
import { autoSeedLibraryOnBoot } from '@/services/library-seed.service';
import { assurerCatalogue } from '@/services/academy-programme.service';

async function bootstrap() {
  await connectMongo();

  // Peuple automatiquement la Librairie design si les collections sont
  // vides (typiquement le tout premier déploiement) — ne touche à rien si
  // elle a déjà été initialisée ou modifiée à la main dans Mongo depuis.
  await autoSeedLibraryOnBoot();

  // Académie : crée les 22 domaines et 60 formations du programme s'ils
  // manquent (textes de base). Ne bloque jamais le démarrage.
  assurerCatalogue().catch((e) => console.error('[academie] Programme non initialisé', e));

  // Vérifie que Redis répond avant de démarrer (utilisé par BullMQ)
  await redisConnection.ping();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 NexAI backend démarré sur le port ${env.PORT} (${env.NODE_ENV})`);
  });

  // ── Mode mono-service (défaut : RUN_WORKER_IN_WEB=true) ─────────
  // Référence vers l'arrêt propre des workers, renseignée uniquement en mode
  // mono-service (le service Worker dédié gère ses propres signaux).
  let stopWorkersRef: (() => Promise<void>) | null = null;

  // Plan free Render : pas de Background Worker → API + worker dans
  // le même process. Plus tard, service Worker dédié + RUN_WORKER_IN_WEB=false.
  if (env.RUN_WORKER_IN_WEB) {
    console.log('⚙️  Mode mono-service (API + worker) — adapté plan free Render');
    const { startWorker, stopWorkers: stop } = await import('@/jobs/worker');
    stopWorkersRef = stop;
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
    // On cesse d'accepter de nouvelles requêtes HTTP, PUIS on laisse les
    // générations en cours se terminer. Sans ça, un déploiement Render tuerait
    // une vidéo en cours de fabrication déjà payée par le client.
    server.close(async () => {
      console.log('✅ Serveur HTTP fermé');
      try {
        if (stopWorkersRef) await stopWorkersRef();
      } catch (err) {
        console.error('Arrêt des workers en erreur', err);
      }
      process.exit(0);
    });
    // Filet de sécurité : Render tue le processus au bout de ~30s. On sort
    // avant plutôt que d'être interrompu au milieu d'une écriture.
    setTimeout(() => process.exit(0), 28_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('❌ Échec du démarrage du backend', err);
  process.exit(1);
});
