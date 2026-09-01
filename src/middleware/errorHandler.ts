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
