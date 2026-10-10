import { Router } from 'express';
import mongoose from 'mongoose';
import { redisConnection } from '@/config/redis';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'nexai-backend', timestamp: new Date().toISOString() });
});

/**
 * GET /health/complet — santé réelle, utilisée par l'agent de garde : le
 * serveur répond ET la base de données ET Redis fonctionnent. 503 sinon.
 * Ne renvoie aucune information sensible.
 */
healthRouter.get('/complet', async (_req, res) => {
  const base = mongoose.connection.readyState === 1;
  const redis = await Promise.race([
    redisConnection.ping().then((r) => r === 'PONG').catch(() => false),
    new Promise<boolean>((ok) => setTimeout(() => ok(false), 3000)),
  ]);
  const ok = base && redis;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degrade', base, redis, timestamp: new Date().toISOString() });
});
