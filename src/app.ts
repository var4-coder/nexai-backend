import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env, isProd } from '@/config/env';
import { router } from '@/routes';
import { errorHandler, notFoundHandler } from '@/middleware/errorHandler';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Render est derrière un proxy — nécessaire pour que req.ip reflète l'IP
  // réelle du client (utilisée pour la limite "3 comptes / IP" en essai).
  app.set('trust proxy', 1);
  app.use(helmet());
  // CORS dynamique : le dashboard NexAI (env.CLIENT_URL) reste seul autorisé
  // partout, SAUF sous /api/v1/public qui doit être appelable depuis
  // n'importe quel domaine (ce sont les sites clients livrés — hébergés sur
  // Netlify sur des domaines qu'on ne connaît pas à l'avance — qui postent
  // leurs formulaires/réservations là, voir routes/public.routes.ts).
  app.use(
    cors((req, callback) => {
      const isPublicSiteBackend = req.path.startsWith('/api/v1/public');
      callback(null, {
        origin: isPublicSiteBackend ? true : env.CLIENT_URL,
        credentials: !isPublicSiteBackend,
      });
    })
  );
  // `verify` capture le buffer brut de la requête AVANT parsing JSON, dans
  // req.rawBody. Indispensable pour vérifier des signatures HMAC de webhooks
  // (ex: Chariow) sur les octets exacts envoyés par le fournisseur — un
  // JSON.stringify(req.body) reparsé peut différer subtilement de l'original
  // (ordre de clés, formatage des nombres, échappement Unicode) et invalider
  // à tort une signature légitime, ou dans certains cas fausser la vérification.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as import('express').Request).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(cookieParser());
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // Rate limiting global — protection de base (voir Partie 11 - Sécurité).
  //
  // Client connecté : compté PAR COMPTE (1 000 requêtes / 15 min). Beaucoup
  // d'opérateurs mobiles partagent une même adresse IP entre des milliers
  // d'abonnés : compter par IP bloquait des clients qui n'avaient rien fait,
  // et une navigation normale (tableau de bord, Académie, suivi d'une
  // création) atteignait vite 300 requêtes. Visiteur anonyme : par IP (300).
  const compteDe = (req: express.Request): string | null => {
    const entete = req.headers.authorization;
    const jeton = entete?.startsWith('Bearer ') ? entete.slice(7) : (req.cookies?.token as string | undefined);
    if (!jeton) return null;
    try {
      const p = jwt.verify(jeton, env.JWT_SECRET) as { userId?: string };
      return p.userId ?? null;
    } catch {
      return null;
    }
  };
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: (req) => (compteDe(req) ? 1000 : 300),
      keyGenerator: (req) => {
        const compte = compteDe(req);
        return compte ? `compte:${compte}` : `ip:${req.ip}`;
      },
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.use('/api/v1', router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
