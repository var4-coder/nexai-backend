import { Types } from 'mongoose';
import { User } from '@/models/User';
import { VideoAd } from '@/models/VideoAd';
import { AppConfig } from '@/models/AppConfig';
import { AppError } from '@/middleware/errorHandler';
import { CREDIT_COSTS, debitCredits } from '@/services/credits.service';
import { videoQueue } from '@/jobs/queue';
import { VIDEO_TEST_INCITATION, VIDEO_TEST_TELECHARGEMENT_VERROUILLE } from '@/constants/textes-client';

/**
 * « Tester Vidéo IA » — Architecture v6, section 7.
 *
 * Même page que Vidéo IA côté client : le bouton « Générer » est verrouillé
 * en essai gratuit, et un second bouton « Tester » le remplace. Cette
 * fonction alimente ce second bouton.
 *
 * Caractéristiques (toutes volontaires) :
 *   - FalAI Kling Avatar Standard, 8 secondes, avatar générique NexAI
 *     + voix personnalisée au nom/activité du client → coût réel ~0,46 $
 *   - 13 crédits sur les 15 offerts : il ne reste que 2 crédits, donc ni un
 *     site (12cr) ni le coach business (3cr) ne sont cumulables. Le prospect
 *     choisit entre découvrir la vidéo IA ou repartir avec un site réel
 *   - UNE SEULE FOIS par compte, verrouillé ensuite
 *   - Streaming uniquement : jamais de téléchargement (la vidéo serait
 *     sinon utilisable ailleurs sans jamais payer)
 */

/** Durée fixe du test — ni configurable, ni négociable côté client. */
export const VIDEO_TEST_DUREE_SECONDES = 8;

/**
 * Plafond quotidien GLOBAL, tous comptes confondus. Ce n'est pas un filtre
 * anti-fraude (il ne détecte rien) mais un plafond de dépense maximale
 * connue à l'avance : au pire 200 × 0,46 $ ≈ 92 $/jour sur cette
 * fonctionnalité, quoi qu'il arrive.
 */
export const VIDEO_TEST_PLAFOND_QUOTIDIEN = 200;

const CLE_COMPTEUR = 'video_test_compteur_quotidien';

/** Clé du jour au format AAAA-MM-JJ (remise à zéro naturelle à minuit UTC). */
function jourCourant(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Incrémente le compteur du jour et refuse si le plafond est atteint.
 * Opération atomique : deux demandes simultanées ne peuvent pas dépasser
 * le plafond ensemble.
 */
async function consommerQuotaQuotidien(): Promise<void> {
  const jour = jourCourant();
  const doc = await AppConfig.findOneAndUpdate(
    { key: CLE_COMPTEUR },
    [
      {
        $set: {
          value: {
            $cond: [
              // Nouveau jour → on repart de 1
              { $ne: [{ $arrayElemAt: [{ $split: ['$value', ':'] }, 0] }, jour] },
              `${jour}:1`,
              // Même jour → incrément
              {
                $concat: [
                  jour,
                  ':',
                  {
                    $toString: {
                      $add: [
                        {
                          $toInt: {
                            $arrayElemAt: [{ $split: [{ $ifNull: ['$value', `${jour}:0`] }, ':'] }, 1],
                          },
                        },
                        1,
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
    { upsert: true, new: true }
  );

  const compte = Number(String(doc?.value ?? `${jour}:1`).split(':')[1] ?? 1);
  if (compte > VIDEO_TEST_PLAFOND_QUOTIDIEN) {
    throw new AppError(
      "Le nombre d'essais vidéo disponibles aujourd'hui est atteint. Réessayez demain, ou passez à un abonnement pour générer vos vidéos sans attendre.",
      429
    );
  }
}

/** État du bouton « Tester », pour que le frontend l'affiche correctement. */
export async function getVideoTestStatus(userId: Types.ObjectId | string) {
  const user = await User.findById(userId).select('plan creditsBalance videoTestUsed videoTestVideoAdId');
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  const estEssai = user.plan === 'trial';
  const dejaUtilise = Boolean(user.videoTestUsed);
  const assezDeCredits = (user.creditsBalance ?? 0) >= CREDIT_COSTS.VIDEO_TEST_ESSAI;

  return {
    // Le bouton n'apparaît QUE pour les comptes en essai : un abonné a
    // accès aux vraies générations, pas à une version bridée.
    visible: estEssai,
    disponible: estEssai && !dejaUtilise && assezDeCredits,
    dejaUtilise,
    coutCredits: CREDIT_COSTS.VIDEO_TEST_ESSAI,
    dureeSecondes: VIDEO_TEST_DUREE_SECONDES,
    videoAdId: user.videoTestVideoAdId ? String(user.videoTestVideoAdId) : null,
    // Jamais de téléchargement, même après génération réussie.
    telechargementAutorise: false,
    messageTelechargement: VIDEO_TEST_TELECHARGEMENT_VERROUILLE,
    messageIncitation: VIDEO_TEST_INCITATION,
    raisonIndisponible: !estEssai
      ? 'reserve_essai'
      : dejaUtilise
      ? 'deja_teste'
      : !assezDeCredits
      ? 'credits_insuffisants'
      : null,
  };
}

/**
 * Lance la génération du test. Réservé à l'essai gratuit, une seule fois.
 */
export async function lancerVideoTest(
  userId: Types.ObjectId | string,
  brief: { brandName?: string; activite?: string }
) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('Utilisateur introuvable', 404);

  if (user.plan !== 'trial') {
    throw new AppError(
      "« Tester Vidéo IA » est réservé à l'essai gratuit. Votre abonnement vous donne accès aux 3 formats vidéo complets.",
      400
    );
  }
  if (user.videoTestUsed) {
    throw new AppError(
      'Vous avez déjà utilisé votre essai vidéo. Passez à un abonnement pour créer vos vidéos publicitaires complètes.',
      403
    );
  }

  // Plafond global AVANT le débit : ne jamais débiter un client qu'on va
  // refuser juste après.
  await consommerQuotaQuotidien();

  // Verrou posé AVANT la génération (et non après) : deux clics rapides ne
  // peuvent pas lancer deux tests. Le débit qui suit échouerait de toute
  // façon faute de crédits, mais autant ne pas engager deux générations.
  const verrou = await User.findOneAndUpdate(
    { _id: user._id, videoTestUsed: { $ne: true } },
    { $set: { videoTestUsed: true } },
    { new: true }
  );
  if (!verrou) {
    throw new AppError('Essai vidéo déjà lancé.', 409);
  }

  try {
    await debitCredits(user._id, CREDIT_COSTS.VIDEO_TEST_ESSAI, 'video_ad', {
      action: 'VIDEO_TEST_ESSAI',
      note: 'Tester Vidéo IA (essai gratuit)',
    });
  } catch (err) {
    // Débit refusé (crédits insuffisants, essai expiré…) → on relâche le
    // verrou, sinon le client perdrait son essai sans rien recevoir.
    await User.updateOne({ _id: user._id }, { $set: { videoTestUsed: false } });
    throw err;
  }

  const videoAd = await VideoAd.create({
    userId: user._id,
    mode: 'avatar_pub',
    format: '30s', // borne du schéma ; la durée réelle est VIDEO_TEST_DUREE_SECONDES
    quality: 'standard',
    aspectRatio: '9:16',
    status: 'queued',
    creditsCharged: CREDIT_COSTS.VIDEO_TEST_ESSAI,
    brief: {
      brandName: brief.brandName ?? '',
      description: brief.activite ?? '',
      // Consignes internes du test — jamais modifiables par le client.
      isTrialTest: true,
      durationSecondsOverride: VIDEO_TEST_DUREE_SECONDES,
      useGenericAvatar: true,
    },
  });

  await User.updateOne({ _id: user._id }, { $set: { videoTestVideoAdId: videoAd._id } });

  const job = await videoQueue.add('generate-video-ad', {
    videoAdId: String(videoAd._id),
    userId: String(user._id),
  });

  return {
    videoAdId: String(videoAd._id),
    jobId: String(job.id),
    dureeSecondes: VIDEO_TEST_DUREE_SECONDES,
    creditsDebites: CREDIT_COSTS.VIDEO_TEST_ESSAI,
    messageIncitation: VIDEO_TEST_INCITATION,
    telechargementAutorise: false,
  };
}
