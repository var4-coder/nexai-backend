/**
 * Librairie interne — 10 niches (source : NexAI_Source_de_Verite_Finale.pdf, B.1 & B.18).
 * Second secours quand MongoDB (collection `library_niches`) est indisponible.
 */

export interface LibraryNicheDoc {
  slug: string;
  nom: string;
  couvre: string;
  /** Ids de composants autorisés pour cette niche (voir components.ts) */
  composants_autorises: string[];
}

const TRANSVERSAUX = [
  'navbar_sticky',
  'skip_link_accessibilite',
  'hero_produit',
  'hero_asymetrie',
  'grille_services_3col',
  'equipe_grid',
  'temoignages_v1',
  'temoignages_v2',
  'galerie_v1',
  'galerie_v2',
  'reservation_cta_bandeau',
  'stats_bandeau',
  'faq_accordeon',
  'footer_simple',
  'footer_multi_colonnes',
  'zone_intervention_carte',
  'avis_google_carousel',
  'listing_biens_grid',
  'formulaire_contact',
];

export const INTERNAL_NICHES: LibraryNicheDoc[] = [
  {
    slug: 'hotellerie_evenementiel',
    nom: 'Hôtellerie & Événementiel',
    couvre: 'Hôtel, chambre d\'hôtes, mariage, salle, tourisme, spa',
    composants_autorises: [...TRANSVERSAUX],
  },
  {
    slug: 'sante_bienetre',
    nom: 'Santé & Bien-être',
    couvre: 'Médecin, ostéopathe, coach santé, spa, yoga, psychologie',
    composants_autorises: [...TRANSVERSAUX],
  },
  {
    slug: 'immobilier_architecture',
    nom: 'Immobilier & Architecture',
    couvre: 'Agence, promoteur, architecte, décorateur',
    composants_autorises: [...TRANSVERSAUX],
  },
  {
    slug: 'services_locaux',
    nom: 'Services locaux',
    couvre: 'Artisan, coiffeur, garage, salon, plombier',
    composants_autorises: [...TRANSVERSAUX],
  },
  {
    slug: 'business_vitrine',
    nom: 'Business vitrine',
    couvre: 'Cabinet, conseil, avocat, expert-comptable, B2B',
    composants_autorises: [...TRANSVERSAUX, 'etudes_de_cas'],
  },
  {
    slug: 'ecommerce_mode',
    nom: 'E-commerce mode',
    couvre: 'Mode, beauté, lifestyle, bijoux, boutique',
    composants_autorises: [...TRANSVERSAUX, 'grille_produits', 'fiche_produit', 'panier_resume'],
  },
  {
    slug: 'portfolio_creatif',
    nom: 'Portfolio créatif',
    couvre: 'Designer, photographe, artiste, agence créative',
    composants_autorises: [...TRANSVERSAUX, 'hero_centre_minimal', 'grille_projets_filtrable'],
  },
  {
    slug: 'tech_startup_saas',
    nom: 'Tech / Startup / SaaS',
    couvre: 'SaaS, outil digital, produit tech, app',
    composants_autorises: [...TRANSVERSAUX, 'table_tarifs', 'logos_clients_bandeau'],
  },
  {
    slug: 'restaurant_gastronomie',
    nom: 'Restaurant & Gastronomie',
    couvre: 'Restaurant, café, bar, traiteur',
    composants_autorises: [...TRANSVERSAUX, 'carte_menu'],
  },
  {
    slug: 'education_formation',
    nom: 'Éducation & Formation',
    couvre: 'École, formation, coach business, e-learning',
    composants_autorises: [...TRANSVERSAUX, 'grille_cours'],
  },
];
