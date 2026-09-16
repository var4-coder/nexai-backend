import { Queue } from 'bullmq';
import { redisConnection } from '@/config/redis';

/**
 * Queue pipeline : génération, lancement, modifications.
 * attempts: 2 = 1 essai + 1 seule reprise max (jamais 3).
 * Reprise utile seulement si erreur transitoire (voir worker + UnrecoverableError).
 */
export const pipelineQueue = new Queue('pipeline', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 30_000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export const remindersQueue = new Queue('reminders', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const qualityQueue = new Queue('quality-agent', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
