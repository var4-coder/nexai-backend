import { getModelForRole, getSecoursForRole } from '@/services/ai-role-registry';
import { appelerModeleTexte } from '@/services/appel-ia-secours.service';
import { bilanReel } from '@/services/bilan.service';

/**
 * Analyse IA du Bilan (admin). Le modèle ne reçoit QUE les vrais chiffres
 * de NexAI et n'a pas le droit d'en inventer : chaque nombre de sa réponse
 * est ensuite vérifié contre les données, et ceux qu'on ne retrouve pas
 * sont signalés à l'admin. Modèle réglable dans Équipe IA (« Bilan
 * financier — analyse et conseils »), avec bascule Claude ⇄ Grok.
 */

const CONSIGNE = `Tu es l'analyste financier de NexAI, une plateforme SaaS de création de sites, logos et vidéos par IA pour l'Afrique francophone (abonnements en FCFA).
On te donne le bilan RÉEL d'une période au format JSON (montants en FCFA).

Règles strictes :
- Utilise UNIQUEMENT les chiffres présents dans le JSON. N'invente aucun chiffre, aucun taux de marché, aucune moyenne du secteur.
- Si une donnée manque ou vaut 0 faute de recul, dis-le simplement au lieu de supposer.
- Recopie les montants tels qu'ils sont dans le JSON (arrondis à l'unité), sans les recalculer d'une autre façon.
- Français simple, phrases courtes, pas de jargon. Pas de tableau.

Structure de la réponse :
1. En bref (3 phrases maximum : résultat de la période et ce qui l'explique).
2. Ce qui marche.
3. Ce qui coûte trop ou bloque.
4. Publicité : quelle plateforme rapporte le mieux (coût par inscrit, coût par abonné), seulement si des dépenses existent.
5. Trois actions concrètes pour la période suivante.`;

/** Tous les nombres présents dans les données (formes entière et arrondie). */
function nombresConnus(donnees: unknown): Set<number> {
  const s = new Set<number>();
  const parcourir = (v: unknown) => {
    if (typeof v === 'number' && isFinite(v)) {
      s.add(Math.round(v));
      s.add(Math.round(v * 100)); // pourcentages fournis en fraction (0,12 → 12)
      s.add(Math.round(v * 1000) / 10);
    } else if (Array.isArray(v)) v.forEach(parcourir);
    else if (v && typeof v === 'object') Object.values(v).forEach(parcourir);
  };
  parcourir(donnees);
  return s;
}

function nombresDuTexte(texte: string): number[] {
  return (texte.match(/\d[\d\s  .]*(?:,\d+)?/g) ?? [])
    .map((m) => Number(m.replace(/[\s  .]/g, '').replace(',', '.')))
    .filter((n) => isFinite(n) && n >= 100);
}

export async function analyserBilan(du: Date, au: Date) {
  const donnees = await bilanReel(du, au);
  const entree = JSON.stringify(donnees);
  const messages = [{ role: 'user' as const, content: `Bilan réel de NexAI :\n${entree}` }];
  const opts = { maxTokens: 2500, temperature: 0.2 };

  const principal = await getModelForRole('analyste_bilan');
  let modele = principal;
  let texte: string;
  try {
    texte = await appelerModeleTexte(principal, CONSIGNE, messages, opts);
  } catch (err) {
    const secours = await getSecoursForRole('analyste_bilan', principal);
    if (!secours) throw err;
    console.error(`[bilan] ${principal} indisponible, analyse faite par ${secours}`, (err as Error)?.message);
    modele = secours;
    texte = await appelerModeleTexte(secours, CONSIGNE, messages, opts);
  }

  const connus = nombresConnus(donnees);
  const nonVerifies = Array.from(new Set(nombresDuTexte(texte).filter((n) => !connus.has(Math.round(n)))));
  return { texte, modele, nombresNonVerifies: nonVerifies.slice(0, 20), periode: donnees.periode };
}
