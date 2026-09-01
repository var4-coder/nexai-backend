/**
 * Librairie interne — règles de copywriting par niche (source : NexAI_Source_de_Verite_Finale.pdf, B.8 & B.9).
 * Second secours quand MongoDB (collection `library_copy`) est indisponible.
 */

export interface LibraryCopyDoc {
  niche: string;
  ton: string;
  longueur_phrases: string;
  focus: string;
  framework: 'PAS' | 'BAB';
  exemple?: {
    intro?: string;
    milieu?: string;
    conclusion?: string;
    headline?: string;
    cta?: string;
  };
}

export const COPY_REGLES_COMMUNES = {
  interdits: [
    'solutions innovantes',
    'excellence',
    'au service de votre réussite',
  ],
  regles: [
    'Transformer le brief client en texte spécifique (nommer le métier, la zone, le résultat concret).',
    'Chaque section importante suit Bénéfice → Preuve → Action quand le contenu le permet.',
    'CTA clairs, à l\'impératif ou à la première personne du pluriel ("Réserver maintenant", "Demander un devis").',
    'Un seul message principal par section. Pas de jargon non expliqué.',
    'Headline ≤ 12 mots, orientée résultat client.',
  ],
};

export const INTERNAL_COPY: LibraryCopyDoc[] = [
  {
    niche: 'services_locaux',
    ton: 'Direct, chaleureux, concret',
    longueur_phrases: 'Courtes (12-18 mots)',
    focus: 'Résultat local, confiance, rapidité',
    framework: 'PAS',
  },
  {
    niche: 'business_vitrine',
    ton: 'Clair, expert, sobre',
    longueur_phrases: 'Moyennes (15-22 mots)',
    focus: 'Expertise, preuve, réduction de risque',
    framework: 'PAS',
  },
  {
    niche: 'ecommerce_mode',
    ton: 'Désirable, précis, sensoriel',
    longueur_phrases: 'Courtes à moyennes',
    focus: 'Produit, bénéfice ressenti, urgence légère',
    framework: 'PAS',
    exemple: {
      intro: 'Votre garde-robe stagne, les pièces basiques s\'usent.',
      milieu: 'Chaque matin, le même dilemme. Rien qui vous ressemble vraiment.',
      conclusion: 'Des pièces durables, pensées pour vous. Livraison offerte dès 80 €.',
      headline: 'Des vêtements qui durent. Un style qui reste.',
      cta: 'Découvrir la collection',
    },
  },
  {
    niche: 'restaurant_gastronomie',
    ton: 'Sensoriel, accueillant',
    longueur_phrases: 'Courtes',
    focus: 'Expérience, goût, ambiance, réservation',
    framework: 'BAB',
    exemple: {
      intro: 'Soirées passées à chercher un restaurant digne d\'une occasion spéciale.',
      milieu: 'Une table, un menu de saison, un service qui anticipe.',
      conclusion: 'Réservez votre expérience en 30 secondes.',
      headline: 'Le dîner que vous méritez enfin.',
      cta: 'Réserver une table',
    },
  },
  {
    niche: 'tech_startup_saas',
    ton: 'Précis, confiant, factuel',
    longueur_phrases: 'Moyennes',
    focus: 'Résultat mesurable, preuve, simplicité',
    framework: 'PAS',
    exemple: {
      intro: 'Vous perdez 12 h/semaine à reconstruire les mêmes rapports.',
      milieu: 'Pendant que vos concurrents livrent plus vite, votre équipe stagne dans Excel.',
      conclusion: 'Automatisez vos dashboards en 1 clic. Essayez gratuitement 14 jours.',
      headline: 'Arrêtez de reconstruire. Commencez à livrer.',
      cta: 'Voir la démo',
    },
  },
  {
    niche: 'sante_bienetre',
    ton: 'Apaisant, crédible, humain',
    longueur_phrases: 'Moyennes',
    focus: 'Bien-être, sécurité, accompagnement',
    framework: 'BAB',
  },
  {
    niche: 'hotellerie_evenementiel',
    ton: 'Élégant, chaleureux',
    longueur_phrases: 'Moyennes',
    focus: 'Expérience, hospitalité, détails sensoriels',
    framework: 'BAB',
  },
  {
    niche: 'portfolio_creatif',
    ton: 'Expressif, maîtrisé',
    longueur_phrases: 'Variables',
    focus: 'Process, vision, résultats concrets',
    framework: 'BAB',
  },
  {
    niche: 'education_formation',
    ton: 'Clair, encourageant, structuré',
    longueur_phrases: 'Moyennes',
    focus: 'Transformation, méthode, résultats',
    framework: 'BAB',
  },
  {
    niche: 'immobilier_architecture',
    ton: 'Clair, expert, sobre',
    longueur_phrases: 'Moyennes (15-22 mots)',
    focus: 'Expertise, preuve, réduction de risque',
    framework: 'PAS',
  },
];
