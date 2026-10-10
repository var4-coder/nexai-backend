import { Types } from 'mongoose';
import { AppError } from '@/middleware/errorHandler';

/**
 * Ancien « Tester Vidéo IA » de l'essai gratuit — RETIRÉ.
 *
 * Il coûtait trop cher par prospect. Les routes GET/POST /video-ads/test
 * restent en place pour répondre proprement aux anciens écrans (bouton
 * jamais affiché, lancement refusé) et la galerie d'exemples le remplace.
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
  throw new AppError(
    'Découvrez nos réalisations vidéo dans la galerie d’exemples. La génération de vidéos est disponible dès l’abonnement Créateur+.',
    403
  );
}
