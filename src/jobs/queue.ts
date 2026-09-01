import { Queue } from 'bullmq';
import { redisConnection } from '@/config/redis';

/**
 * Une seule queue "pipeline" pour l'instant : génération de site, réparation,
 * logo, redéploiement, modifications post-lancement (niveaux 2 et 3).
 * Le type de job (voir models/Job.ts) détermine le traitement dans le worker.
 *
 * Les workers eux-mêmes (Codeur → Scan → Juges → Réparateur → ...) seront
 * implémentés en Phase 2, une fois l'auth et les crédits en place.
 */
export const pipelineQueue = new Queue('pipeline', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1, // le pipeline gère lui-même ses propres cycles de réparation (voir Partie A.7)
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/**
 * Queue dédiée aux tâches planifiées (Partie commerciale — Pub 4 : relance
 * différée Coach business). Séparée de 'pipeline' pour ne jamais faire
 * attendre une génération de site derrière un scan de relance.
 */
export const remindersQueue = new Queue('reminders', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
