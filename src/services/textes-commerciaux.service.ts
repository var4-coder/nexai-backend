import { TexteCommercial, ITexteCommercial } from '@/models/TexteCommercial';
import { callClaude } from '@/services/ai-clients';
import { AppError } from '@/middleware/errorHandler';

/**
 * Mise à jour des textes commerciaux après un changement de tarif.
 *
 * Sonnet 5 relit chaque texte, repère ceux qui mentionnent une valeur
 * devenue fausse, et propose une version corrigée. Rien n'est publié : la
 * proposition attend la validation de l'administrateur, qui peut la
 * modifier avant.
 *
 * Ce garde-fou est volontaire. Un modèle qui réécrirait seul une vitrine
 * commerciale pourrait déformer une promesse — un prix, une inclusion, une
 * limite — sans que personne ne le voie avant les clients.
 */

const MODELE = 'claude-sonnet-5';

const CONSIGNE = `Tu mets à jour les textes commerciaux d'une plateforme de création de sites web.

On te donne un texte affiché aux clients, et les valeurs ACTUELLES de l'offre.

Ta tâche : si le texte mentionne un prix, un nombre de crédits, une durée ou
une inclusion qui ne correspond plus aux valeurs actuelles, réécris-le avec
les bonnes valeurs.

RÈGLES ABSOLUES :
- Ne change QUE ce qui est devenu faux. Garde le ton, le style, la longueur.
- N'invente aucune promesse, n'ajoute aucune fonctionnalité.
- Si le texte est toujours exact, ne propose rien.

Réponds UNIQUEMENT en JSON :
{"aChanger": false} ou {"aChanger": true, "nouveau": "...", "motif": "..."}`;

function lireJson<T>(brut: string): T | null {
  try {
    const n = brut.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const d = n.indexOf('{');
    const f = n.lastIndexOf('}');
    if (d === -1 || f === -1) return null;
    return JSON.parse(n.slice(d, f + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Fait relire tous les textes par Sonnet et enregistre les propositions.
 * Ne publie rien. Renvoie le nombre de textes pour lesquels une correction
 * est proposée.
 */
export async function proposerMiseAJourTextes(valeursActuelles: string): Promise<{
  analyses: number;
  propositions: number;
}> {
  const textes = await TexteCommercial.find({});
  let propositions = 0;

  for (const texte of textes) {
    try {
      const brut = await callClaude(
        MODELE,
        CONSIGNE,
        [
          {
            role: 'user',
            content:
              `VALEURS ACTUELLES DE L'OFFRE :\n${valeursActuelles}\n\n` +
              `TEXTE (${texte.emplacement}${texte.role ? ` — ${texte.role}` : ''}) :\n${texte.contenu}`,
          },
        ],
        { maxTokens: 1500, temperature: 0.2 }
      );

      const verdict = lireJson<{ aChanger?: boolean; nouveau?: string; motif?: string }>(brut);
      if (!verdict?.aChanger || !verdict.nouveau?.trim()) continue;

      texte.propositionContenu = verdict.nouveau.trim();
      texte.propositionMotif = verdict.motif?.trim() || 'Valeurs mises à jour.';
      texte.propositionLe = new Date();
      await texte.save();
      propositions += 1;
    } catch (err) {
      // Un texte qui échoue ne doit pas interrompre les autres.
      console.warn(`[textes] Analyse échouée pour « ${texte.cle} »`, err);
    }
  }

  return { analyses: textes.length, propositions };
}

/**
 * Publie une proposition, éventuellement corrigée par l'administrateur.
 * C'est le SEUL chemin qui modifie un texte visible par les clients.
 */
export async function validerProposition(
  cle: string,
  contenuCorrige?: string
): Promise<ITexteCommercial> {
  const texte = await TexteCommercial.findOne({ cle });
  if (!texte) throw new AppError('Texte introuvable.', 404);

  const nouveau = contenuCorrige?.trim() || texte.propositionContenu?.trim();
  if (!nouveau) throw new AppError('Aucune proposition à publier pour ce texte.', 400);

  texte.contenu = nouveau;
  texte.propositionContenu = null;
  texte.propositionMotif = null;
  texte.propositionLe = null;
  texte.majLe = new Date();
  texte.majPar = contenuCorrige ? 'admin' : 'sonnet';
  await texte.save();
  return texte;
}

/** Écarte une proposition sans rien publier. */
export async function rejeterProposition(cle: string): Promise<void> {
  await TexteCommercial.updateOne(
    { cle },
    { $set: { propositionContenu: null, propositionMotif: null, propositionLe: null } }
  );
}

/**
 * Textes commerciaux de départ.
 *
 * Sans eux, l'onglet Tarifs reste vide : rien ne les crée automatiquement,
 * et l'administrateur ne peut donc rien modifier. Ce sont les phrases
 * réellement affichées aux clients, celles qui mentionnent un prix ou une
 * inclusion et qui doivent suivre chaque changement de tarif.
 */
const TEXTES_INITIAUX: {
  cle: string;
  emplacement: ITexteCommercial['emplacement'];
  role: string;
  contenu: string;
}[] = [
  {
    cle: 'accueil.essai',
    emplacement: 'accueil',
    role: "Encadré de l'essai gratuit sur la page d'accueil",
    contenu:
      "15 crédits offerts à l'inscription. De quoi trouver votre idée d'activité avec le Coach business (3 crédits) puis créer un vrai site (12 crédits) — les deux, exactement.",
  },
  {
    cle: 'accueil.video',
    emplacement: 'accueil',
    role: 'Présentation de la vidéo IA sur la page d’accueil',
    contenu:
      "Créez vos publicités vidéo : 20 secondes à partir de 23 crédits, 30 secondes à 39, 60 secondes à 80. Le mini-film de 2 minutes, en qualité cinéma, est réservé à l'abonnement Pro Max.",
  },
  {
    cle: 'accueil.hebergement',
    emplacement: 'accueil',
    role: "Argument d'hébergement sur la page d'accueil",
    contenu:
      "Votre site est hébergé gratuitement, à vie. Tant que votre abonnement est actif, sans aucune limite de visiteurs.",
  },
  {
    cle: 'guide.cout_site',
    emplacement: 'guide',
    role: 'Guide — combien coûte la création d’un site',
    contenu:
      "Créer un site coûte 12 crédits en qualité Normale, ou 25 en Premium avec notre meilleure IA. La mise en ligne coûte 15 crédits. Modifier les textes vous-même est gratuit ; les faire retoucher par l'IA coûte 8 crédits.",
  },
  {
    cle: 'guide.cout_video',
    emplacement: 'guide',
    role: 'Guide — combien coûte une vidéo',
    contenu:
      "Publicité avec présentateur : 23 crédits (20 s), 39 (30 s), 80 (60 s). Publicité avec voix off : 27, 45 et 92 crédits. Mini-film de 2 minutes : 160 crédits, réservé à Pro Max.",
  },
  {
    cle: 'guide.abonnements',
    emplacement: 'guide',
    role: 'Guide — les abonnements et leurs crédits',
    contenu:
      "Starter 5 000 FCFA (30 crédits) : Académie, Boutique et Coach. Créateur+ 10 000 FCFA (80 crédits) : sites, logos, domaines et vidéos. Agence 25 000 FCFA (220 crédits) : 10 clients et Analytics. Pro Max 35 000 FCFA (320 crédits) : clients illimités et mini-film.",
  },
  {
    cle: 'aide.sans_abonnement',
    emplacement: 'aide',
    role: 'Aide — ce qui change sans abonnement actif',
    contenu:
      "Sans abonnement actif, votre site reste en ligne et gratuit jusqu'à 3 000 visiteurs par mois. Vous ne pouvez plus le modifier ni en créer d'autres, et l'encaissement via votre compte NexAI est suspendu — mais votre propre lien de paiement continue de fonctionner.",
  },
  {
    cle: 'video.mini_film',
    emplacement: 'video',
    role: 'Écran vidéo — descriptif du mini-film',
    contenu:
      "Deux minutes en qualité cinéma. Pour votre entreprise, une vraie publicité de présentation. Pour les créateurs de contenu, des histoires prêtes à publier sur TikTok, Instagram ou Facebook. Réservé à l'abonnement Pro Max.",
  },
  {
    cle: 'abonnement.cadeau',
    emplacement: 'abonnement',
    role: 'Abonnement — cadeau de bienvenue',
    contenu:
      "Une vidéo de 20 secondes vous est offerte à votre première souscription, dès l'abonnement Créateur+.",
  },
  {
    cle: 'credits.packs',
    emplacement: 'credits',
    role: 'Page crédits — packs hors abonnement',
    contenu:
      "Les crédits hors abonnement sont à 150 FCFA l'unité : packs de 10, 20, 50, 100 ou 200 crédits.",
  },
];

/**
 * Crée les textes manquants, sans jamais écraser ceux qui existent.
 *
 * Peut donc être relancé sans risque : une modification de l'administrateur
 * n'est jamais perdue.
 */
export async function initialiserTextes(): Promise<{ crees: number; existants: number }> {
  let crees = 0;
  let existants = 0;

  for (const t of TEXTES_INITIAUX) {
    const deja = await TexteCommercial.findOne({ cle: t.cle }).select('_id');
    if (deja) {
      existants += 1;
      continue;
    }
    await TexteCommercial.create({ ...t, majLe: new Date(), majPar: 'admin' });
    crees += 1;
  }

  return { crees, existants };
}
