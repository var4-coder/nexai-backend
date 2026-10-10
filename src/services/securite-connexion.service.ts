import crypto from 'crypto';
import { env } from '@/config/env';
import { redisConnection } from '@/config/redis';
import { AppError } from '@/middleware/errorHandler';

/**
 * Protections de connexion.
 *
 * 1. Verrouillage par compte : 5 mots de passe faux en 15 minutes bloquent
 *    le compte 15 minutes, quelle que soit l'adresse IP de l'attaquant (la
 *    limite par IP ne suffit pas contre une attaque répartie).
 * 2. Double vérification des comptes sensibles (admin, associé) : après le
 *    bon mot de passe, un code à 6 chiffres est envoyé par email. Un mot de
 *    passe volé ne suffit donc plus pour entrer dans l'administration.
 *    Désactivable en urgence (ADMIN_DOUBLE_VERIFICATION=off sur Render), et
 *    ignorée tant que l'envoi d'emails n'est pas configuré (sinon l'admin se
 *    retrouverait enfermé dehors).
 */

const MAX_ECHECS = 5;
const FENETRE_S = 15 * 60;
const DUREE_CODE_S = 10 * 60;
const MAX_ESSAIS_CODE = 5;

const cle = (email: string) => `connexion:echecs:${email.toLowerCase().trim()}`;
const hacher = (valeur: string) => crypto.createHash('sha256').update(`${valeur}:${env.JWT_SECRET}`).digest('hex');

export async function verifierVerrouillage(email: string): Promise<void> {
  const n = Number(await redisConnection.get(cle(email)).catch(() => 0)) || 0;
  if (n >= MAX_ECHECS) {
    throw new AppError('Trop de tentatives sur ce compte. Réessayez dans 15 minutes ou réinitialisez votre mot de passe.', 429);
  }
}

export async function noterEchec(email: string): Promise<void> {
  const k = cle(email);
  const n = await redisConnection.incr(k).catch(() => 0);
  if (n === 1) await redisConnection.expire(k, FENETRE_S).catch(() => undefined);
}

export async function effacerEchecs(email: string): Promise<void> {
  await redisConnection.del(cle(email)).catch(() => undefined);
}

/** Rôles soumis à la double vérification par email. */
export function exigeDoubleVerification(role: string): boolean {
  if ((process.env.ADMIN_DOUBLE_VERIFICATION || '').toLowerCase() === 'off') return false;
  if (!env.BREVO_API_KEY) return false;
  return role === 'admin' || role === 'finance';
}

/** Crée le code de connexion (stocké haché, 10 minutes) et le renvoie pour l'envoi par email. */
export async function creerCodeConnexion(userId: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await redisConnection.set(`connexion:code:${userId}`, JSON.stringify({ h: hacher(code), essais: 0 }), 'EX', DUREE_CODE_S);
  return code;
}

export async function verifierCodeConnexion(userId: string, code: string): Promise<void> {
  const k = `connexion:code:${userId}`;
  const brut = await redisConnection.get(k);
  if (!brut) throw new AppError('Code expiré. Reconnectez-vous pour en recevoir un nouveau.', 400);
  const etat = JSON.parse(brut) as { h: string; essais: number };
  if (etat.essais >= MAX_ESSAIS_CODE) {
    await redisConnection.del(k);
    throw new AppError('Trop d’essais. Reconnectez-vous pour recevoir un nouveau code.', 429);
  }
  const attendu = Buffer.from(etat.h);
  const recu = Buffer.from(hacher(code.trim()));
  if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) {
    etat.essais += 1;
    const ttl = await redisConnection.ttl(k);
    await redisConnection.set(k, JSON.stringify(etat), 'EX', Math.max(ttl, 1));
    throw new AppError('Code incorrect.', 400);
  }
  await redisConnection.del(k);
}
