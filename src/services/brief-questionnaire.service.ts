import { COMPOSITIONS_MINI_FILM } from '@/services/video-pipeline.service';
import { AVATAR_OPTIONS } from '@/services/avatar-choix.service';

/**
 * Questionnaire guidé du brief vidéo.
 *
 * Un client qui ne sait pas quoi écrire écrit peu, ou mal — et le scénariste
 * n'a alors rien d'exploitable. Plutôt que de lui laisser une zone de texte
 * vide, on lui pose des questions précises, dans son langage, adaptées au
 * mode qu'il a choisi.
 *
 * Aucune question n'est bloquante : ce qui manque est deviné ou inventé par
 * le scénariste. L'objectif est d'aider, jamais de barrer la route.
 */

export type TypeChamp = 'texte' | 'texte_long' | 'choix' | 'choix_multiple';

export interface QuestionBrief {
  cle: string;
  question: string;
  /** Phrase d'aide, affichée sous la question. */
  aide?: string;
  type: TypeChamp;
  /** Exemple concret, affiché en gris dans le champ. */
  exemple?: string;
  options?: readonly { valeur: string; label: string; description?: string }[];
  /** Une réponse ici améliore nettement le résultat. */
  important?: boolean;
}

/** Questions posées quel que soit le mode. */
const COMMUNES: QuestionBrief[] = [
  {
    cle: 'brandName',
    question: 'Quel est le nom de votre marque ou de votre activité ?',
    type: 'texte',
    exemple: 'Chez Aminata',
    important: true,
  },
  {
    cle: 'produit',
    question: 'Que voulez-vous mettre en avant dans cette vidéo ?',
    aide: 'Un produit précis, un service, une promotion, ou votre activité en général.',
    type: 'texte',
    exemple: 'Ma crème hydratante au beurre de karité',
    important: true,
  },
  {
    cle: 'cible',
    question: 'À qui s’adresse cette vidéo ?',
    aide: 'Plus vous êtes précis, plus la vidéo leur parlera.',
    type: 'texte',
    exemple: 'Des femmes de 25 à 40 ans à Cotonou',
    important: true,
  },
  {
    cle: 'atout',
    question: 'Qu’est-ce qui vous distingue des autres ?',
    aide: 'Un prix, une qualité, une rapidité, un savoir-faire…',
    type: 'texte',
    exemple: 'Fabriqué à la main, livré en 24 h',
  },
  {
    cle: 'appelAction',
    question: 'Que doit faire la personne après avoir vu la vidéo ?',
    type: 'choix',
    options: [
      { valeur: 'visiter', label: 'Visiter mon site' },
      { valeur: 'commander', label: 'Commander directement' },
      { valeur: 'appeler', label: 'M’appeler ou m’écrire' },
      { valeur: 'boutique', label: 'Venir à ma boutique' },
    ],
  },
  {
    cle: 'ton',
    question: 'Quelle ambiance voulez-vous ?',
    type: 'choix',
    options: [
      { valeur: 'chaleureux', label: 'Chaleureux et proche' },
      { valeur: 'dynamique', label: 'Dynamique et rythmé' },
      { valeur: 'elegant', label: 'Élégant et haut de gamme' },
      { valeur: 'rassurant', label: 'Sérieux et rassurant' },
    ],
  },
];

/** Questions propres au mini-film. */
const MINI_FILM: QuestionBrief[] = [
  {
    cle: 'composition',
    question: 'Quel type de mini-film voulez-vous ?',
    type: 'choix',
    options: COMPOSITIONS_MINI_FILM,
    important: true,
  },
  {
    cle: 'scenario',
    question: 'Avez-vous une histoire ou une idée de scène en tête ?',
    aide:
      'Racontez-la simplement, comme à un ami. Si vous n’en avez pas, laissez vide : nous écrirons une histoire qui met votre offre en valeur.',
    type: 'texte_long',
    exemple:
      'Une femme découvre ma crème chez une amie, l’essaie, et revient en acheter le lendemain.',
  },
];

/** Questions propres aux modes avec présentateur. */
const AVATAR: QuestionBrief[] = [
  {
    cle: 'avatar.genre',
    question: 'Votre présentateur est un homme ou une femme ?',
    type: 'choix',
    options: AVATAR_OPTIONS.genre,
  },
  {
    cle: 'avatar.carnation',
    question: 'Quelle carnation ?',
    type: 'choix',
    options: AVATAR_OPTIONS.carnation,
  },
  {
    cle: 'avatar.age',
    question: 'Quel âge environ ?',
    type: 'choix',
    options: AVATAR_OPTIONS.age,
  },
  {
    cle: 'avatar.style',
    question: 'Comment doit-il être habillé ?',
    type: 'choix',
    options: AVATAR_OPTIONS.style,
  },
];

/**
 * Questionnaire à poser pour un mode donné.
 *
 * Le mini-film reçoit d'abord le choix de composition : selon la réponse, le
 * frontend affiche ensuite les questions du film narratif ou celles du
 * présentateur.
 */
export function questionnairePourMode(
  mode: 'voix_off' | 'avatar_pub' | 'mini_film',
  composition?: string
): QuestionBrief[] {
  if (mode === 'avatar_pub') return [...COMMUNES, ...AVATAR];
  if (mode === 'voix_off') return COMMUNES;

  // Mini-film : la composition décide de la suite.
  // Avec présentateur : pas de scénario à raconter, mais le choix de l'avatar.
  if (composition === 'presentateur') return [...MINI_FILM.slice(0, 1), ...COMMUNES, ...AVATAR];
  // Avec ou sans acteur : le client peut raconter son histoire.
  return [...MINI_FILM, ...COMMUNES];
}

/**
 * Relance une réponse trop vague, sans jamais bloquer.
 *
 * Renvoie une question de reformulation, ou null si la réponse suffit. Le
 * client reste libre de passer outre : mieux vaut une vidéo imparfaite qu'un
 * client bloqué à l'étape du formulaire.
 */
export function relancerSiVague(cle: string, reponse: string): string | null {
  const texte = reponse.trim().toLowerCase();
  if (texte.length === 0) return null;

  const VAGUES = [
    'produit',
    'produits',
    'service',
    'services',
    'business',
    'commerce',
    'vente',
    'articles',
    'tout',
    'divers',
  ];

  if (cle === 'produit' && (texte.length < 8 || VAGUES.includes(texte))) {
    return 'Précisez lequel : « des produits » ne permet pas de filmer grand-chose. Par exemple : « ma crème au karité », « mes pagnes wax », « mes coupes de cheveux ».';
  }
  if (cle === 'cible' && texte.length < 8) {
    return 'Qui sont ces personnes ? Leur âge, leur ville, ce qu’elles cherchent — la vidéo leur parlera mieux.';
  }
  return null;
}
