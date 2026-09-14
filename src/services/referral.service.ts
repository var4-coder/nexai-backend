import { Types } from 'mongoose';
import { User } from '@/models/User';
import { creditCredits } from '@/services/credits.service';
import { AppError } from '@/middleware/errorHandler';

/**
 * Programme de parrainage — Architecture v6, section 16.
 *
 * Principe central anti-fraude : la récompense n'est JAMAIS versée à
 * l'inscription du filleul, uniquement à sa PREMIÈRE conversion payante.
 * Créer de faux comptes ne rapporte donc rien tant qu'il n'y a pas un vrai
 * paiement derrière — ce qui supprime l'intérêt du farming de comptes.
 */

/** Récompense versée au parrain, à la première conversion payante du filleul. */
export const REFERRAL_REWARD_CREDITS = 50;

/**
 * Plafond mensuel de parrainages récompensés par compte — filet de sécurité
 * financier même si une fraude isolée passe entre les mailles des autres
 * protections. Ne bloque pas le parrainage lui-même, seulement la récompense.
 */
export const REFERRAL_MONTHLY_CAP = 10;

/** Alphabet sans caractères ambigus (0/O, 1/I/L) — code dicté à l'oral sans erreur. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function randomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Génère un code de parrainage unique. Réessaie en cas de collision (rare :
 * 31^8 ≈ 850 milliards de combinaisons), échoue proprement plutôt que de
 * risquer un doublon silencieux.
 */
export async function generateUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const exists = await User.exists({ referralCode: code });
    if (!exists) return code;
  }
  throw new AppError('Impossible de générer un code de parrainage, réessayez.', 500);
}

/**
 * Résout un code de parrain saisi à l'inscription. Ne lève jamais d'erreur
 * bloquante : un code invalide ne doit pas empêcher quelqu'un de créer son
 * compte — on ignore simplement le parrainage.
 */
export async function resolveReferralCode(code?: string): Promise<Types.ObjectId | null> {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const parrain = await User.findOne({ referralCode: normalized }).select('_id');
  return parrain?._id ?? null;
}

/**
 * Vérifie si un parrain a atteint son plafond mensuel de récompenses.
 * Compte les filleuls déjà récompensés sur le mois calendaire en cours.
 */
async function hasReachedMonthlyCap(parrainId: Types.ObjectId): Promise<boolean> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const count = await User.countDocuments({
    referredByUserId: parrainId,
    referralRewardGranted: true,
    updatedAt: { $gte: startOfMonth },
  });
  return count >= REFERRAL_MONTHLY_CAP;
}

/**
 * Verse la récompense au parrain, à appeler UNIQUEMENT à la confirmation
 * d'un premier paiement d'abonnement (webhook Chariow — jamais à
 * l'inscription).
 *
 * Ne lève jamais d'erreur bloquante : un problème de parrainage ne doit
 * jamais faire échouer la confirmation d'un paiement réel. Les refus sont
 * journalisés et renvoyés dans le résultat.
 */
export async function grantReferralRewardOnFirstPayment(
  filleulId: Types.ObjectId | string
): Promise<{ granted: boolean; reason?: string; parrainId?: string }> {
  try {
    const filleul = await User.findById(filleulId).select(
      'referredByUserId referralRewardGranted deviceFingerprint ipHash email'
    );
    if (!filleul) return { granted: false, reason: 'filleul_introuvable' };
    if (!filleul.referredByUserId) return { granted: false, reason: 'pas_de_parrain' };

    // Idempotence : ne récompense qu'à la PREMIÈRE conversion payante.
    if (filleul.referralRewardGranted) {
      return { granted: false, reason: 'deja_recompense' };
    }

    const parrain = await User.findById(filleul.referredByUserId).select(
      'deviceFingerprint ipHash email'
    );
    if (!parrain) return { granted: false, reason: 'parrain_introuvable' };

    // Auto-parrainage explicite
    if (String(parrain._id) === String(filleul._id)) {
      return { granted: false, reason: 'auto_parrainage' };
    }

    // Protection empreinte appareil : même appareil/navigateur = très
    // probablement la même personne qui se parraine elle-même.
    if (
      filleul.deviceFingerprint &&
      parrain.deviceFingerprint &&
      filleul.deviceFingerprint === parrain.deviceFingerprint
    ) {
      console.warn(
        `[parrainage] Récompense bloquée (empreinte appareil identique) parrain=${parrain.email} filleul=${filleul.email}`
      );
      // Marqué comme traité pour ne pas réévaluer ce cas à chaque paiement.
      filleul.referralRewardGranted = true;
      await filleul.save();
      return { granted: false, reason: 'empreinte_identique' };
    }

    // Plafond mensuel par parrain
    if (await hasReachedMonthlyCap(parrain._id)) {
      console.warn(`[parrainage] Plafond mensuel atteint pour parrain=${parrain.email}`);
      return { granted: false, reason: 'plafond_mensuel_atteint' };
    }

    // Versement immédiat, sans délai d'attente (décision produit : le filleul
    // a payé, le parrain est récompensé tout de suite).
    await creditCredits(parrain._id, REFERRAL_REWARD_CREDITS, 'ajustement_admin', {
      note: `parrainage:${filleul.email}`,
    });

    filleul.referralRewardGranted = true;
    await filleul.save();

    console.log(
      `[parrainage] ${REFERRAL_REWARD_CREDITS} crédits versés à ${parrain.email} (filleul ${filleul.email})`
    );
    return { granted: true, parrainId: String(parrain._id) };
  } catch (err) {
    // Jamais bloquant pour le paiement en cours.
    console.error('[parrainage] Échec du versement de la récompense (non bloquant) :', err);
    return { granted: false, reason: 'erreur_interne' };
  }
}

/** Statistiques de parrainage affichées au client dans son compte. */
export async function getReferralStats(userId: Types.ObjectId | string) {
  const user = await User.findById(userId).select('referralCode');
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  // Génère le code à la volée si le compte est antérieur au programme.
  if (!user.referralCode) {
    user.referralCode = await generateUniqueReferralCode();
    await user.save();
  }

  const [totalFilleuls, filleulsConvertis] = await Promise.all([
    User.countDocuments({ referredByUserId: userId }),
    User.countDocuments({ referredByUserId: userId, referralRewardGranted: true }),
  ]);

  return {
    code: user.referralCode,
    totalFilleuls,
    filleulsConvertis,
    creditsGagnes: filleulsConvertis * REFERRAL_REWARD_CREDITS,
    recompenseParFilleul: REFERRAL_REWARD_CREDITS,
    // Texte affiché au client — la règle doit être limpide pour éviter les
    // réclamations ("j'ai parrainé 3 personnes et je n'ai rien reçu").
    regle: `Vous recevez ${REFERRAL_REWARD_CREDITS} crédits dès qu'un filleul souscrit son premier abonnement payant. Aucun crédit n'est versé à la simple inscription.`,
  };
}
