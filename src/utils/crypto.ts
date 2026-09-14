import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Hash irréversible de l'IP du client — utilisé uniquement pour appliquer la
 * limite "max 3 comptes par IP" en essai gratuit (voir A.7.1). On ne stocke
 * jamais l'IP en clair.
 */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

/**
 * Code de vérification email à 6 chiffres, envoyé via Brevo.
 */
export function generateVerificationCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Clé publique par site (Site.publicApiKey), embarquée dans le HTML/JS ou le
 * projet Next.js livré au client pour authentifier les appels au backend
 * public (voir routes/public.routes.ts). Pas un secret critique — juste un
 * identifiant suffisamment imprévisible pour éviter le spam croisé entre sites.
 */
export function generatePublicApiKey(): string {
  return `pk_${crypto.randomBytes(24).toString('hex')}`;
}

export async function hashValue(value: string): Promise<string> {
  return bcrypt.hash(value, SALT_ROUNDS);
}

export async function compareValue(value: string, hash: string): Promise<boolean> {
  return bcrypt.compare(value, hash);
}
