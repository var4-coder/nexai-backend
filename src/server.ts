import { createApp } from '@/app';
import { env } from '@/config/env';
import { connectMongo } from '@/config/db';
import { redisConnection } from '@/config/redis';

async function bootstrap() {
  await connectMongo();

  // Vérifie que Redis répond avant de démarrer (utilisé par BullMQ)
  await redisConnection.ping();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 NexAI backend démarré sur le port ${env.PORT} (${env.NODE_ENV})`);
  });

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
