import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Tokens de vue Académie — courte durée, à usage unique dans le temps (2 min),
 * scellés au couple (utilisateur, contenu). Remplace l'ancien "viewerToken"
 * en base64url qui n'était ni signé ni vérifié nulle part.
 *
 * Objectif : le frontend n'obtient jamais l'URL Cloudinary réelle. Il obtient
 * un token de courte durée qu'il doit présenter à la route de streaming
 * (/academy/:id/stream ou /academy/:id/video-stream), qui revérifie l'accès
 * (plan, abonnement) à l'instant T avant de servir les octets.
 */

const VIEW_TOKEN_TTL = '2m';

export type AcademyViewPurpose = 'pdf' | 'video';

export interface AcademyViewTokenPayload {
  userId: string;
  contentId: string;
  purpose: AcademyViewPurpose;
}

export function signAcademyViewToken(payload: AcademyViewTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: VIEW_TOKEN_TTL });
}

export function verifyAcademyViewToken(
  token: string,
  expected: { userId: string; contentId: string; purpose: AcademyViewPurpose }
): AcademyViewTokenPayload {
  let decoded: AcademyViewTokenPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as AcademyViewTokenPayload;
  } catch {
    throw new AppError('Lien de visionnage expiré, rechargez la page', 401);
  }

  if (
    decoded.userId !== expected.userId ||
    decoded.contentId !== expected.contentId ||
    decoded.purpose !== expected.purpose
  ) {
    throw new AppError('Lien de visionnage invalide', 401);
  }

  return decoded;
}
