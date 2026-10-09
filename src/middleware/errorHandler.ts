import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { estErreurTechnique, MESSAGE_RESEAU_INDISPONIBLE } from '@/utils/erreur-client';

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

  // Identifiant mal formé (ex. « contact.html » à la place d'un id) : c'est
  // une ressource introuvable, pas une panne. Jamais d'alerte incident.
  if ((err as { name?: string }).name === 'CastError') {
    return res.status(404).json({ error: { message: 'Ressource introuvable' } });
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
  // Panne d'un fournisseur (IA à court de crédit, API indisponible…) : le
  // client voit « Réseau indisponible », jamais le détail technique ;
  // l'administrateur garde le message complet et un incident est ouvert.
  const role = _req.auth?.role;
  const technique = estErreurTechnique(err.message);
  if (technique && statusCode !== 500) {
    import('@/services/platform-alert.service')
      .then(({ signalerIncident }) =>
        signalerIncident({
          composant: 'integration',
          erreur: err?.message ?? String(err),
          contexte: `${_req.method} ${_req.baseUrl || ''}${_req.route?.path ?? ''}`,
          gravite: /credit balance|insufficient_quota|api[_ ]key|authentication/i.test(err.message) ? 'critique' : 'moyenne',
        })
      )
      .catch(() => {});
  }
  const messageClient =
    role === 'admin'
      ? err.message
      : technique
        ? MESSAGE_RESEAU_INDISPONIBLE
        : statusCode >= 500
          ? MESSAGE_RESEAU_INDISPONIBLE
          : err.message;
  res.status(technique && role !== 'admin' ? 503 : statusCode).json({
    error: {
      message: messageClient,
      details:
        err instanceof AppError && (role === 'admin' || (!technique && statusCode < 500)) ? err.details : undefined,
    },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { message: 'Route introuvable' } });
}
