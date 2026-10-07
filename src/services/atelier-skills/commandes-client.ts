import { SkillRequest } from '@/models/AtelierSkills';
import type { IPosteReglage } from '@/models/AtelierSkills';
import { creditCredits } from '@/services/credits.service';

/**
 * Commandes de skills passées par les clients (Skill NexAI).
 *
 * Plafond de coût fournisseur PAR EXÉCUTION, relance interne comprise (le
 * plafond du pipeline porte sur le cumul de l'exécution). Il fonde le prix
 * (voir CREDIT_COSTS.SKILL_NEXAI) : ne pas le relever sans relever le prix.
 */
export const PLAFOND_COMMANDE_CLIENT_USD = 2.0;

/** Budget restant minimal pour qu'une relance interne automatique soit tentée. */
export const BUDGET_MINI_RELANCE_USD = 0.5;

/** Délai avant que le client puisse relancer lui-même une commande non aboutie. */
export const DELAI_RELANCE_CLIENT_MS = 30 * 60 * 1000;

/**
 * Réglages propres aux commandes des clients (les skills de l'admin, destinés
 * à la boutique, gardent les réglages complets). Le Rédacteur 1 passe de
 * gpt-6-astra (0,52 $ par exécution) à gpt-5.6-sol (≈ 0,21 $) : c'est ce qui
 * rend le prix de 25 crédits compatible avec 75 % de marge. Les 3 rédacteurs
 * restent de 3 fournisseurs différents (OpenAI, Anthropic, xAI).
 */
export const POSTES_COMMANDE_CLIENT: Record<string, IPosteReglage> = {
  redacteur1: { modele: 'gpt-5.6-sol', effort: 'medium' },
};

/**
 * Remboursement d'une commande, UNE seule fois. Réservé au cas où NOUS
 * n'avons pas pu lancer la commande (débit fait, lancement impossible).
 * Une commande lancée mais non aboutie n'est jamais remboursée
 * automatiquement : relance gratuite, puis assistance.
 */
export async function rembourserCommandeSkill(requestId: string, motif: string): Promise<boolean> {
  const demande = await SkillRequest.findOneAndUpdate(
    { _id: requestId, userId: { $exists: true }, creditsDebites: { $gt: 0 }, rembourse: { $ne: true } },
    { $set: { rembourse: true } },
    { new: true }
  );
  if (!demande || !demande.userId || !demande.creditsDebites) return false;
  try {
    await creditCredits(demande.userId, demande.creditsDebites, 'skill_nexai_remboursement', {
      note: `Skill NexAI remboursé — ${motif}`,
    });
    return true;
  } catch (err) {
    await SkillRequest.updateOne({ _id: requestId }, { $set: { rembourse: false } });
    throw err;
  }
}
