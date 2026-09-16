import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProd } from '@/config/env';

export class AppError extends Error {
  statusCode: number;
  /** Données structurées optionnelles (ex : liste d'éléments manquants pour un brief incomplet). */
  details?: unknown;
  constructor(message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message || 'Requête invalide';
    return res.status(400).json({
      error: {
        message,
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  const statusCode = err instanceof AppError ? err.statusCode : 500;
  console.error(err);

  // Erreur 500 non maîtrisée = incident plateforme. Fable la diagnostique
  // en tâche de fond et l'administrateur est notifié (Sécurité & Maintenance).
  // Les AppError (4xx) sont des refus métier volontaires, jamais des incidents.
  if (statusCode === 500 && !(err instanceof AppError)) {
    import('@/services/platform-alert.service')
      .then(({ signalerIncident }) =>
        signalerIncident({
          composant: 'api',
          erreur: err?.message ?? String(err),
          stack: err?.stack,
          contexte: `${_req.method} ${_req.originalUrl}`,
        })
      )
      .catch(() => {});
  }
  res.status(statusCode).json({
    error: {
      message: statusCode === 500 && isProd ? 'Erreur serveur interne' : err.message,
      details: err instanceof AppError ? err.details : undefined,
    },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { message: 'Route introuvable' } });
}
