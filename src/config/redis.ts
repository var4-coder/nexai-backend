import IORedis, { Redis } from 'ioredis';
import { env } from './env';

/**
 * Connexion Redis unique, réutilisée par toutes les queues/workers BullMQ
 * (voir src/jobs/queue.ts). BullMQ exige maxRetriesPerRequest: null sur les
 * connexions utilisées par ses workers/queues.
 */
export function createRedisConnection(): Redis {
  const url = env.REDIS_PROVIDER === 'render' && env.REDIS_URL_RENDER ? env.REDIS_URL_RENDER : env.REDIS_URL;
  console.log(`[redis] Fournisseur : ${env.REDIS_PROVIDER === 'render' && env.REDIS_URL_RENDER ? 'Render' : 'Upstash'}`);
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
  });

  connection.on('connect', () => console.log('✅ Redis connecté'));
  connection.on('error', (err) => console.error('❌ Erreur Redis', err));

  return connection;
}

export const redisConnection = createRedisConnection();
