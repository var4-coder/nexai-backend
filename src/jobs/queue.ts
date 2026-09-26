import { Queue } from 'bullmq';
import { redisConnection } from '@/config/redis';

/**
 * Files de traitement — SITES et VIDÉOS sont volontairement SÉPARÉES.
 *
 * Pourquoi cette séparation
 * -------------------------
 * Les deux charges n'ont rien de comparable :
 *   - un site  : ~1 à 3 minutes, surtout des appels IA (attente réseau)
 *   - une vidéo : ~4 à 10 minutes, appels réseau PUIS montage ffmpeg qui
 *                 sature un cœur CPU entier
 *
 * Partager une même file les ferait se bloquer mutuellement : quelques vidéos
 * en cours immobiliseraient toutes les commandes de site, sans aucun rapport
 * entre elles. Chaque file a donc sa propre capacité, et un client n'est
 * jamais ralenti par un type de commande qui ne le concerne pas.
 */

/** Options communes : 1 essai + 1 seule reprise. */
const pipelineJobOptions = {
  attempts: 2,
  backoff: {
    type: 'exponential' as const,
    delay: 30_000,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * File SITES : génération, modification IA, mise en ligne.
 *
 * Travaux courts et majoritairement en attente réseau (appels aux modèles IA),
 * donc peu gourmands en CPU : ils supportent une concurrence élevée.
 */
export const siteQueue = new Queue('pipeline', {
  connection: redisConnection,
  defaultJobOptions: pipelineJobOptions,
});

/**
 * File VIDÉOS : génération de publicités IA.
 *
 * Travaux longs qui se terminent par un montage ffmpeg, lequel sature un cœur
 * CPU. La concurrence doit rester alignée sur le nombre de cœurs réellement
 * disponibles, sinon tous les montages ralentissent simultanément.
 */
export const videoQueue = new Queue('pipeline-video', {
  connection: redisConnection,
  defaultJobOptions: pipelineJobOptions,
});

/** Alias de la file SITES, utilisé par les points d'appel du pipeline site. */
export const pipelineQueue = siteQueue;

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

/**
 * File ACADÉMIE : fabrication des vidéos IA (PDF → script → voix → montage).
 *
 * Séparée des vidéos publicitaires : l'admin qui fabrique ses cours ne doit
 * jamais ralentir les commandes des clients. Une seule tentative : une erreur
 * est affichée dans l'admin, qui relance lui-même (le script déjà écrit et
 * validé n'est jamais perdu).
 */
export const academyVideoQueue = new Queue('academy-video', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});
