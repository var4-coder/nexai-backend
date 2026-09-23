import { Types } from 'mongoose';
import { AppError } from '@/middleware/errorHandler';

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


/** État du bouton « Tester », pour que le frontend l'affiche correctement. */
export async function getVideoTestStatus(_userId: Types.ObjectId | string) {
  // Le test vidéo n'est plus proposé : le bouton ne doit jamais apparaître.
  // On renvoie un statut explicite plutôt qu'une erreur, pour que le
  // frontend masque simplement l'option.
  return {
    visible: false,
    disponible: false,
    raisonIndisponible:
      'Découvrez nos réalisations vidéo dans la galerie d’exemples. La génération de vidéos est disponible dès l’abonnement Créateur+.',
  };
}

/**
 * Lance la génération du test. Réservé à l'essai gratuit, une seule fois.
 */
export async function lancerVideoTest(
  _userId: Types.ObjectId | string,
  _brief: { brandName?: string; activite?: string }
): Promise<never> {
  // Le test vidéo de l'essai gratuit n'est plus proposé.
  //
  // Il coûtait 0,46 $ par prospect — plus que tout le reste de l'essai réuni
  // — et attirait des visiteurs venus chercher une vidéo gratuite sans
  // intention d'achat. La galerie d'exemples le remplace : visible par tous,
  // produite une seule fois.
  //
  // Les 15 crédits de l'essai couvrent désormais exactement le coach business
  // (3) et la création d'un site (12).
  throw new AppError(
    'Découvrez nos réalisations vidéo dans la galerie d’exemples. La génération de vidéos est disponible dès l’abonnement Créateur+.',
    403
  );
}
