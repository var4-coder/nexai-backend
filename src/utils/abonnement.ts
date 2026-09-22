import type { UserPlan } from '@/models/User';

/**
 * Durée d'une période d'abonnement payée, en jours.
 * Un paiement ouvre (ou prolonge) l'abonnement de cette durée.
 */
export const DUREE_ABONNEMENT_JOURS = 30;

/** Plans payants — tous sauf l'essai gratuit. */
const PLANS_PAYANTS: ReadonlySet<UserPlan> = new Set(['starter', 'createur', 'agence', 'pro_max']);

export type EtatAbonnement = {
  plan: UserPlan;
  planExpiresAt?: Date | null;
  role?: string;
};

/**
 * L'abonnement du compte est-il ACTIF ?
 *
 * Source unique de vérité : toute décision qui dépend de l'abonnement
 * (modifier un site, en créer un, encaisser, afficher la mention NexAI,
 * appliquer le quota d'hébergement) doit passer par cette fonction, jamais
 * par une lecture directe de `plan`. Un abonné expiré garde en effet
 * l'étiquette de son plan : `plan === 'createur'` ne dit PAS qu'il paie.
 *
 * Règles :
 *  - l'administrateur est toujours actif ;
 *  - l'essai gratuit n'est pas un abonnement payé ;
 *  - un plan payant est actif tant que planExpiresAt n'est pas dépassée ;
 *  - un plan payant sans date d'expiration est considéré actif : ce sont les
 *    comptes créés avant l'introduction de cette date, qu'on ne veut pas
 *    couper brutalement. Ils reçoivent une date au prochain paiement.
 */
export function aUnAbonnementActif(user: EtatAbonnement, maintenant = new Date()): boolean {
  if (user.role === 'admin') return true;
  if (!PLANS_PAYANTS.has(user.plan)) return false;
  if (!user.planExpiresAt) return true;
  return new Date(user.planExpiresAt).getTime() > maintenant.getTime();
}

/**
 * Nouvelle date de fin après un paiement.
 *
 * Si l'abonnement est encore actif, la période s'AJOUTE à la date de fin
 * existante : un client qui renouvelle en avance ne perd aucun jour déjà
 * payé. S'il a expiré, la nouvelle période démarre aujourd'hui.
 */
export function prolongerAbonnement(finActuelle: Date | null | undefined, maintenant = new Date()): Date {
  const base =
    finActuelle && new Date(finActuelle).getTime() > maintenant.getTime()
      ? new Date(finActuelle)
      : new Date(maintenant);
  base.setDate(base.getDate() + DUREE_ABONNEMENT_JOURS);
  return base;
}

/** Nombre de jours écoulés depuis la fin de l'abonnement (0 si actif). */
export function joursDepuisFinAbonnement(user: EtatAbonnement, maintenant = new Date()): number {
  if (aUnAbonnementActif(user, maintenant) || !user.planExpiresAt) return 0;
  const ecart = maintenant.getTime() - new Date(user.planExpiresAt).getTime();
  return Math.max(0, Math.floor(ecart / (1000 * 60 * 60 * 24)));
}
