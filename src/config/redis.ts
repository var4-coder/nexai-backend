import IORedis, { Redis } from 'ioredis';
import { env } from './env';

/**
 * Connexion Redis unique, réutilisée par toutes les queues/workers BullMQ
 * (voir src/jobs/queue.ts). BullMQ exige maxRetriesPerRequest: null sur les
 * connexions utilisées par ses workers/queues.
 */
export function createRedisConnection(): Redis {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  connection.on('connect', () => console.log('✅ Redis connecté'));
  connection.on('error', (err) => console.error('❌ Erreur Redis', err));

  return connection;
}

export const redisConnection = createRedisConnection();
