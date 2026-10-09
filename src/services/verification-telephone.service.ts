import crypto from 'crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { env } from '@/config/env';
import { AppConfig } from '@/models/AppConfig';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';

/**
 * Vérification du téléphone par SMS (Brevo) avant le site d'essai gratuit.
 *
 * - Un numéro ne donne droit qu'à UN site d'essai (il ne peut être vérifié
 *   que sur un seul compte).
 * - Le numéro vérifié sert ensuite aux relances (WhatsApp, appels).
 * - Activable / désactivable depuis l'admin (Sécurité) : désactivée, rien
 *   n'est demandé au client.
 */

const CLE_REGLAGE = 'verification_telephone';
const DUREE_CODE_MS = 10 * 60_000;
const DELAI_RENVOI_MS = 60_000;
const MAX_TENTATIVES = 5;
/** Garde-fou contre l'envoi massif de SMS payants par un même compte. */
const MAX_ENVOIS_PAR_JOUR = 5;

export const CODE_TELEPHONE_A_VERIFIER = 'TELEPHONE_A_VERIFIER';

let cache: { actif: boolean; lu: number } | null = null;

export async function verificationTelephoneActive(): Promise<boolean> {
  if (cache && Date.now() - cache.lu < 30_000) return cache.actif;
  const ligne = await AppConfig.findOne({ key: CLE_REGLAGE }).lean();
  let actif = false;
  try {
    actif = Boolean(ligne?.value && JSON.parse(ligne.value).actif);
  } catch {
    actif = false;
  }
  cache = { actif, lu: Date.now() };
  return actif;
}

export async function reglerVerificationTelephone(actif: boolean) {
  await AppConfig.findOneAndUpdate(
    { key: CLE_REGLAGE },
    { key: CLE_REGLAGE, value: JSON.stringify({ actif }) },
    { upsert: true }
  );
  cache = null;
  return { actif, expediteur: env.BREVO_SMS_SENDER, brevoConfigure: Boolean(env.BREVO_API_KEY) };
}

export async function statutReglageAdmin() {
  return {
    actif: await verificationTelephoneActive(),
    expediteur: env.BREVO_SMS_SENDER,
    brevoConfigure: Boolean(env.BREVO_API_KEY),
    numerosVerifies: await User.countDocuments({ telephoneVerifie: { $exists: true, $ne: null } }),
  };
}

const hacher = (code: string, userId: string) =>
  crypto.createHash('sha256').update(`${code}:${userId}:${env.JWT_SECRET}`).digest('hex');

/** Numéro au format international (+229…), ou erreur claire pour le client. */
export function normaliserNumero(numero: string, pays?: string): string {
  const brut = String(numero || '').trim();
  const tel = parsePhoneNumberFromString(brut, (pays || undefined) as CountryCode | undefined);
  if (!tel || !tel.isValid()) {
    throw new AppError('Numéro de téléphone invalide. Vérifiez le pays et le numéro.', 400);
  }
  return tel.number; // E.164, ex. +2290197000000
}

async function envoyerSms(numeroE164: string, contenu: string) {
  if (!env.BREVO_API_KEY) {
    console.warn(`⚠️  BREVO_API_KEY absent — SMS simulé (dev). ${numeroE164} : ${contenu}`);
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: env.BREVO_SMS_SENDER,
      recipient: numeroE164.replace(/^\+/, ''),
      content: contenu,
      type: 'transactional',
      tag: 'verification_telephone',
    }),
  });
  if (!res.ok) {
    const corps = await res.text().catch(() => '');
    // Le client voit « Service indisponible » ; l'admin reçoit un incident
    // (un seul tant que la panne n'est pas résolue : crédits SMS épuisés…).
    const message = `Brevo SMS error ${res.status}: ${corps.slice(0, 300)}`;
    import('@/services/platform-alert.service')
      .then(({ signalerIncident }) =>
        signalerIncident({
          composant: 'integration',
          erreur: `${message} — les codes de vérification du téléphone ne partent plus (crédits SMS Brevo ? expéditeur ?).`,
          contexte: 'verification telephone',
          gravite: 'critique',
          categorie: 'serieuse',
        })
      )
      .catch(() => {});
    throw new AppError(message, 502);
  }
}

export async function envoyerCodeTelephone(userId: string, numero: string, pays?: string) {
  if (!(await verificationTelephoneActive())) {
    throw new AppError('La vérification du téléphone n’est pas demandée pour le moment.', 400);
  }
  const e164 = normaliserNumero(numero, pays);
  const user = await User.findById(userId).select('+codeTelephone telephoneVerifie');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  if (user.telephoneVerifie === e164) return { envoye: false, dejaVerifie: true, numero: e164 };

  const autre = await User.exists({ telephoneVerifie: e164, _id: { $ne: user._id } });
  if (autre) {
    throw new AppError(
      'Ce numéro est déjà utilisé par un autre compte NexAI. Un numéro ne donne droit qu’à un seul site d’essai gratuit.',
      409
    );
  }

  const maintenant = Date.now();
  const c = user.codeTelephone;
  if (c?.lastSentAt && maintenant - new Date(c.lastSentAt).getTime() < DELAI_RENVOI_MS) {
    throw new AppError('Patientez une minute avant de demander un nouveau code.', 429);
  }
  const debutFenetre = c?.fenetreDebut && maintenant - new Date(c.fenetreDebut).getTime() < 24 * 3600_000 ? c.fenetreDebut : new Date();
  const envois = debutFenetre === c?.fenetreDebut ? (c?.envois ?? 0) : 0;
  if (envois >= MAX_ENVOIS_PAR_JOUR) {
    throw new AppError('Trop de codes demandés aujourd’hui. Réessayez demain ou contactez l’Assistance.', 429);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await envoyerSms(e164, `NexAI : votre code de verification est ${code}. Il expire dans 10 minutes.`);

  user.codeTelephone = {
    hash: hacher(code, String(user._id)),
    numero: e164,
    expiresAt: new Date(maintenant + DUREE_CODE_MS),
    attempts: 0,
    lastSentAt: new Date(maintenant),
    envois: envois + 1,
    fenetreDebut: debutFenetre,
  };
  await user.save();
  return { envoye: true, dejaVerifie: false, numero: e164 };
}

export async function verifierCodeTelephone(userId: string, code: string) {
  const user = await User.findById(userId).select('+codeTelephone telephoneVerifie');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  const c = user.codeTelephone;
  if (!c?.hash || !c.numero) throw new AppError('Demandez d’abord un code.', 400);
  if (new Date(c.expiresAt).getTime() < Date.now()) throw new AppError('Code expiré. Demandez un nouveau code.', 400);
  if ((c.attempts ?? 0) >= MAX_TENTATIVES) throw new AppError('Trop de tentatives. Demandez un nouveau code.', 429);

  const ok = crypto.timingSafeEqual(Buffer.from(hacher(String(code).trim(), String(user._id))), Buffer.from(c.hash));
  if (!ok) {
    c.attempts = (c.attempts ?? 0) + 1;
    user.markModified('codeTelephone');
    await user.save();
    throw new AppError('Code incorrect.', 400);
  }
  const autre = await User.exists({ telephoneVerifie: c.numero, _id: { $ne: user._id } });
  if (autre) throw new AppError('Ce numéro est déjà utilisé par un autre compte NexAI.', 409);

  user.telephoneVerifie = c.numero;
  user.telephoneVerifieLe = new Date();
  user.codeTelephone = undefined;
  await user.save();
  return { verifie: true, numero: c.numero };
}

/**
 * À appeler avant de lancer un site d'essai : si la vérification est
 * activée et que le compte d'essai n'a pas de numéro vérifié, on refuse avec
 * un code que l'interface reconnaît pour ouvrir la fenêtre de vérification.
 */
export async function exigerTelephoneVerifie(user: { plan?: string; role?: string; telephoneVerifie?: string | null }) {
  if (user.role === 'admin' || user.plan !== 'trial') return;
  if (user.telephoneVerifie) return;
  if (!(await verificationTelephoneActive())) return;
  throw new AppError('Vérifiez votre numéro de téléphone pour lancer votre site gratuit.', 403, {
    code: CODE_TELEPHONE_A_VERIFIER,
  });
}
