import { callClaude } from '@/services/ai-clients';
import { Avis } from '@/models/Avis';
import { AppError } from '@/middleware/errorHandler';

/**
 * Génération d'avis vitrine par Sonnet 5 — Administration.
 *
 * Ces avis sont marqués `source: 'genere_admin'` et sont donc EXCLUS du
 * calcul du seuil négatif NexAI (voir quality-report.service.ts). Ils
 * servent uniquement à alimenter la page d'accueil ; ils ne peuvent jamais
 * masquer un problème de qualité réel signalé par de vrais clients.
 */

const CONTEXTE_NEXAI = `NexAI est une plateforme SaaS africaine (facturation en FCFA) qui permet à
n'importe qui de créer un site web professionnel sans compétence technique, grâce à l'IA.

Ce que propose NexAI :
- Création de site web complet par IA en quelques minutes, avec aperçu avant publication
- Coach business : pour ceux qui n'ont pas encore d'idée d'activité, l'IA propose une activité
  concrète et un plan pour démarrer
- Vidéos publicitaires par IA : avatar présentateur, pub voix off, mini-films pour réseaux sociaux
- Création de logos professionnels
- Academy : formations en ligne (PDF et vidéos)
- Boutique : produits digitaux prêts à revendre
- Espace Agence : gestion de plusieurs sites clients pour les revendeurs
- Nom de domaine personnalisé, hébergement et sécurité inclus
- Paiement : le client encaisse via son propre lien, ou via le compte NexAI qui lui reverse
  ses gains (Mobile Money, USDT, BTC)
- Système de crédits, abonnements mensuels de Starter à Pro Max
- Assistance client disponible à tout moment

Public : entrepreneurs, commerçants, artisans, restaurateurs, coiffeurs, agents immobiliers,
formateurs, créateurs de contenu — principalement en Afrique de l'Ouest (Bénin, Côte d'Ivoire,
Sénégal, Togo, Burkina, Mali, Cameroun) et dans la diaspora.`;

const SYSTEME = `Tu rédiges des témoignages clients authentiques pour NexAI.

${CONTEXTE_NEXAI}

Règles impératives :
- Chaque avis doit être CRÉDIBLE : un bénéfice concret et vérifiable, pas une publicité creuse.
  Mauvais : "NexAI est génial, je recommande !"
  Bon : "J'ai créé le site de mon salon en une soirée. Trois clientes ont réservé la semaine suivante."
- Varie fortement : métiers, pays, tons, longueurs (1 à 3 phrases), niveaux de langue.
- Prénoms et noms réalistes de la zone (Afrique de l'Ouest, diaspora).
- Mentionne des fonctionnalités RÉELLES de la liste ci-dessus, jamais inventées.
- Aucune promesse de gain chiffré irréaliste, aucune mention de prix précis.
- Rédige en français naturel, parfois familier — comme un vrai client, pas un rédacteur.
- Notes : majoritairement 5, quelques 4. Jamais moins (ce sont des avis vitrine).

Réponds UNIQUEMENT avec un tableau JSON, sans texte autour :
[{"name":"Prénom Nom","role":"Métier, Ville","content":"...","rating":5}]`;

export interface AvisGenere {
  name: string;
  role: string;
  content: string;
  rating: number;
}

/**
 * Génère des avis et les enregistre. Plafonné à 20 par appel pour borner
 * le coût et le temps de réponse — l'admin peut relancer autant que voulu.
 */
export async function genererAvis(nombre: number): Promise<{ crees: number; avis: AvisGenere[] }> {
  const n = Math.max(1, Math.min(Math.floor(nombre), 20));

  // Les avis déjà présents sont transmis au modèle pour qu'il ne répète
  // ni les mêmes prénoms, ni les mêmes métiers, ni les mêmes tournures.
  const existants = await Avis.find({ source: 'genere_admin' })
    .sort({ createdAt: -1 })
    .limit(30)
    .select('name role')
    .lean();

  const aEviter = existants.length
    ? `\n\nÉvite ces profils déjà utilisés : ${existants
        .map((a) => `${a.name} (${a.role})`)
        .join(' ; ')}`
    : '';

  const brut = await callClaude(
    'claude-sonnet-5',
    SYSTEME,
    [{ role: 'user', content: `Rédige exactement ${n} témoignages clients NexAI.${aEviter}` }],
    { maxTokens: 3000, temperature: 0.95 }
  );

  let parsed: AvisGenere[];
  try {
    const nettoye = brut.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(nettoye);
    if (!Array.isArray(parsed)) throw new Error('format');
  } catch {
    throw new AppError("La génération n'a pas produit un format exploitable. Réessayez.", 502);
  }

  const valides = parsed
    .filter((a) => a && typeof a.name === 'string' && typeof a.content === 'string')
    .slice(0, n)
    .map((a) => ({
      name: String(a.name).slice(0, 80),
      role: String(a.role ?? '').slice(0, 120),
      content: String(a.content).slice(0, 600),
      rating: Math.min(5, Math.max(4, Number(a.rating) || 5)),
    }));

  if (valides.length === 0) {
    throw new AppError('Aucun avis exploitable généré. Réessayez.', 502);
  }

  await Avis.insertMany(
    valides.map((a) => ({
      ...a,
      source: 'genere_admin' as const,
      active: true,
    }))
  );

  return { crees: valides.length, avis: valides };
}
