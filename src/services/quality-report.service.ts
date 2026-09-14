import { Site } from '@/models/Site';
import { VideoAd } from '@/models/VideoAd';
import { Avis } from '@/models/Avis';

/**
 * Rapport qualité NexAI — Architecture v6, section 18.
 *
 * Calcule le "Pourcentage seuil négatif NexAI" : la MOYENNE de trois taux
 * indépendants, chacun exprimé sur sa propre base.
 *
 *   seuil = moyenne( % avis négatifs , % sites échoués , % vidéos rejetées )
 *
 * Choix assumé de la moyenne plutôt que de la somme : la somme de trois
 * pourcentages indépendants dépasse rapidement 100% et ne veut plus rien
 * dire. La moyenne reste un vrai pourcentage lisible entre 0 et 100, et le
 * seuil de déclenchement (40%) garde un sens intuitif.
 *
 * À 40% ou plus, le système déclenche l'analyse automatique des prompts
 * (Fable détecte → Sonnet propose → l'admin valide).
 */

/** Seuil de déclenchement de l'analyse automatique des prompts. */
export const SEUIL_NEGATIF_DECLENCHEMENT = 40;

export interface RapportQualite {
  /** Moyenne des 3 taux — c'est LA valeur comparée au seuil de 40% */
  seuilNegatifGlobal: number;
  declenchementAtteint: boolean;
  taux: {
    avisNegatifs: { pourcentage: number; negatifs: number; total: number };
    sitesEchoues: { pourcentage: number; echoues: number; total: number };
    videosRejetees: { pourcentage: number; rejetees: number; total: number };
  };
  /** Niches dont le taux d'échec dépasse la moyenne — pistes de diagnostic */
  nichesFaibles: Array<{ niche: string; echoues: number; total: number; pourcentage: number }>;
  /** Sites livrés sous le seuil de qualité, à examiner */
  sitesFaibles: Array<{ id: string; niche: string; score: number | null; plan: string | null; date: Date }>;
  periode: { depuis: Date; jusqu: Date };
}

function pct(partie: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((partie / total) * 1000) / 10; // 1 décimale
}

/**
 * Construit le rapport sur une fenêtre glissante (30 jours par défaut).
 * Une fenêtre, pas "depuis toujours" : un incident ancien déjà corrigé ne
 * doit pas continuer de plomber l'indicateur indéfiniment.
 */
export async function buildRapportQualite(joursFenetre = 30): Promise<RapportQualite> {
  const jusqu = new Date();
  const depuis = new Date(jusqu.getTime() - joursFenetre * 24 * 60 * 60 * 1000);
  const fenetre = { createdAt: { $gte: depuis } };

  const [
    avisTotal,
    avisNegatifs,
    sitesTotal,
    sitesEchoues,
    videosTotal,
    videosRejetees,
    parNiche,
    sitesFaiblesRaw,
  ] = await Promise.all([
    // SEULS les avis de vrais clients entrent dans l'indicateur qualité.
    // Les avis générés par l'admin (source: 'genere_admin') sont exclus :
    // sinon il suffirait d'en générer quelques-uns pour masquer un vrai
    // problème de qualité et empêcher Fable de se déclencher.
    Avis.countDocuments({ ...fenetre, source: 'client' }),
    // Un avis est "négatif" à 2 étoiles ou moins sur 5.
    Avis.countDocuments({ ...fenetre, source: 'client', rating: { $lte: 2 } }),
    Site.countDocuments(fenetre),
    Site.countDocuments({ ...fenetre, status: { $in: ['failed', 'pending_support'] } }),
    VideoAd.countDocuments(fenetre),
    VideoAd.countDocuments({ ...fenetre, status: { $in: ['failed', 'refunded'] } }),
    // Répartition des échecs par niche — permet à Fable de cibler son
    // diagnostic (une niche précise plutôt qu'un problème systémique).
    Site.aggregate<{ _id: string; total: number; echoues: number }>([
      { $match: fenetre },
      {
        $group: {
          _id: '$niche',
          total: { $sum: 1 },
          echoues: {
            $sum: { $cond: [{ $in: ['$status', ['failed', 'pending_support']] }, 1, 0] },
          },
        },
      },
    ]),
    Site.find({ ...fenetre, status: { $in: ['failed', 'pending_support'] } })
      .select('niche proposals createdAt userId')
      .populate<{ userId: { plan?: string } }>('userId', 'plan')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const tauxAvis = pct(avisNegatifs, avisTotal);
  const tauxSites = pct(sitesEchoues, sitesTotal);
  const tauxVideos = pct(videosRejetees, videosTotal);

  // Moyenne des 3 taux (jamais la somme — voir l'en-tête de ce fichier).
  const seuilNegatifGlobal = Math.round(((tauxAvis + tauxSites + tauxVideos) / 3) * 10) / 10;

  const nichesFaibles = parNiche
    .map((n) => ({
      niche: n._id,
      echoues: n.echoues,
      total: n.total,
      pourcentage: pct(n.echoues, n.total),
    }))
    .filter((n) => n.echoues > 0)
    .sort((a, b) => b.pourcentage - a.pourcentage);

  const sitesFaibles = sitesFaiblesRaw.map((s) => {
    const props = (s as unknown as { proposals?: Array<{ score?: number }> }).proposals ?? [];
    const meilleurScore = props.length
      ? Math.max(...props.map((p) => p.score ?? 0))
      : null;
    return {
      id: String(s._id),
      niche: String((s as unknown as { niche?: string }).niche ?? '—'),
      score: meilleurScore,
      plan: (s as unknown as { userId?: { plan?: string } }).userId?.plan ?? null,
      date: (s as unknown as { createdAt: Date }).createdAt,
    };
  });

  return {
    seuilNegatifGlobal,
    declenchementAtteint: seuilNegatifGlobal >= SEUIL_NEGATIF_DECLENCHEMENT,
    taux: {
      avisNegatifs: { pourcentage: tauxAvis, negatifs: avisNegatifs, total: avisTotal },
      sitesEchoues: { pourcentage: tauxSites, echoues: sitesEchoues, total: sitesTotal },
      videosRejetees: { pourcentage: tauxVideos, rejetees: videosRejetees, total: videosTotal },
    },
    nichesFaibles,
    sitesFaibles,
    periode: { depuis, jusqu },
  };
}
