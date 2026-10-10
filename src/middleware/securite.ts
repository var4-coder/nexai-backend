import type { NextFunction, Request, Response } from 'express';

/**
 * Anti-injection NoSQL : retire de la requête toute clé qui commence par « $ »
 * (ex. { "email": { "$ne": null } }) et les clés de prototype, avant qu'elle
 * n'atteigne une requête MongoDB. Les données normales ne sont pas touchées.
 */
function nettoyer(valeur: unknown, profondeur = 0): unknown {
  if (profondeur > 20 || valeur === null || typeof valeur !== 'object') return valeur;
  if (Array.isArray(valeur)) return valeur.map((v) => nettoyer(v, profondeur + 1));
  const propre: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(valeur as Record<string, unknown>)) {
    if (cle.startsWith('$') || cle === '__proto__' || cle === 'constructor' || cle === 'prototype') continue;
    propre[cle] = nettoyer(v, profondeur + 1);
  }
  return propre;
}

export function antiInjection(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = nettoyer(req.body);
  // req.query est en lecture seule dans Express 5 : on nettoie ses valeurs en place.
  const q = req.query as Record<string, unknown>;
  for (const cle of Object.keys(q)) {
    if (cle.startsWith('$')) delete q[cle];
    else if (q[cle] && typeof q[cle] === 'object') q[cle] = nettoyer(q[cle]);
  }
  for (const cle of Object.keys(req.params ?? {})) {
    if (typeof req.params[cle] !== 'string') delete req.params[cle];
  }
  next();
}

/**
 * Vérifie le CONTENU d'une image envoyée (signature des premiers octets), pas
 * seulement le type annoncé par le navigateur, qui peut être falsifié pour
 * faire passer un autre fichier pour une image.
 */
export function estVraieImage(buffer: Buffer, typeAnnonce: string): boolean {
  if (!buffer || buffer.length < 12) return false;
  const debut = (octets: number[]) => octets.every((o, i) => buffer[i] === o);
  switch (typeAnnonce) {
    case 'image/png':
      return debut([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return debut([0xff, 0xd8, 0xff]);
    case 'image/webp':
      return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    case 'image/svg+xml': {
      const texte = buffer.toString('utf8', 0, Math.min(buffer.length, 200_000));
      // Un SVG peut contenir du code : refusé s'il en embarque.
      return /<svg[\s>]/i.test(texte) && !/<script|\son[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i.test(texte);
    }
    case 'application/pdf':
      return buffer.toString('ascii', 0, 5) === '%PDF-';
    default:
      return false;
  }
}
