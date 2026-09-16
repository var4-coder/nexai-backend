/**
 * Librairie interne — composants de référence (source : NexAI_Source_de_Verite_Finale.pdf, B.15).
 *
 * Sert de SECOND SECOURS quand MongoDB (collection `library_components`) est indisponible
 * ou ne renvoie rien pour la niche demandée. Même forme de document que Mongo :
 * { id, niches: string[] ('*' = toutes), structure, etats, responsive, data_nexai_id, notes? }
 *
 * 29 composants au total (15 transversaux avec variantes + 14 spécifiques par niche),
 * conforme au compte annoncé en B.15 du document source.
 */

export interface LibraryComponentDoc {
  id: string;
  /** '*' = disponible pour toutes les niches, sinon liste de slugs de niche */
  niches: string[];
  nom: string;
  structure: string;
  etats?: string;
  responsive?: string;
  data_nexai_id: string;
  notes?: string;
}

export const INTERNAL_COMPONENTS: LibraryComponentDoc[] = [
  // ── Transversaux (toutes niches) ──────────────────────────────────
  {
    id: 'navbar_sticky',
    niches: ['*'],
    nom: 'Navbar sticky',
    structure: '<header role="banner"> > <nav aria-label="Navigation principale">. Skip link obligatoire en tout premier enfant du body.',
    etats: 'default · scrolled (ombre md) · mobile (hamburger + dialog)',
    responsive: 'Desktop : liens horizontaux. Mobile : menu full-screen ou drawer.',
    data_nexai_id: 'nav-main',
  },
  {
    id: 'skip_link_accessibilite',
    niches: ['*'],
    nom: 'Skip link accessibilité',
    structure: 'Lien "Aller au contenu" visible au focus clavier, premier élément du body.',
    data_nexai_id: 'skip-link',
  },
  {
    id: 'hero_produit',
    niches: ['*'],
    nom: 'Hero — variante A (produit)',
    structure: 'Capture/UI au-dessus de la fold + headline ≤ 12 mots + 1 CTA.',
    etats: 'default · hover CTA · focus',
    responsive: 'Stack vertical sur mobile.',
    data_nexai_id: 'hero-primary',
  },
  {
    id: 'hero_asymetrie',
    niches: ['*'],
    nom: 'Hero — variante B (asymétrie)',
    structure: 'Texte d\'un côté, visuel de l\'autre.',
    etats: 'default · hover CTA · focus',
    responsive: 'Stack vertical sur mobile.',
    data_nexai_id: 'hero-primary',
  },
  {
    id: 'hero_centre_minimal',
    niches: ['portfolio_creatif'],
    nom: 'Hero — variante C (centré minimal)',
    structure: 'Réservée au portfolio créatif. Centré, minimal, grande respiration.',
    etats: 'default · hover CTA · focus',
    responsive: 'Stack vertical sur mobile.',
    data_nexai_id: 'hero-primary',
  },
  {
    id: 'grille_services_3col',
    niches: ['*'],
    nom: 'Grille services 3 colonnes',
    structure: 'Grille de services/prestations, 3 colonnes desktop.',
    responsive: '1 colonne mobile → 3 colonnes desktop.',
    data_nexai_id: 'services-grid',
  },
  {
    id: 'equipe_grid',
    niches: ['*'],
    nom: 'Grille équipe',
    structure: 'Photos + nom + rôle des membres de l\'équipe.',
    responsive: '1-2 colonnes mobile → 3-4 colonnes desktop.',
    data_nexai_id: 'team-grid',
  },
  {
    id: 'temoignages_v1',
    niches: ['*'],
    nom: 'Témoignages — variante 1',
    structure: 'Citation sémantique <blockquote> + avatar + nom + rôle.',
    data_nexai_id: 'testimonial-1',
  },
  {
    id: 'temoignages_v2',
    niches: ['*'],
    nom: 'Témoignages — variante 2 (carousel)',
    structure: 'Citation sémantique + avatar + nom + rôle, en carousel accessible.',
    data_nexai_id: 'testimonial-2',
  },
  {
    id: 'galerie_v1',
    niches: ['*'],
    nom: 'Galerie — variante 1 (grille)',
    structure: 'Grille d\'images avec alt text descriptif.',
    data_nexai_id: 'gallery-1',
  },
  {
    id: 'galerie_v2',
    niches: ['*'],
    nom: 'Galerie — variante 2 (carousel)',
    structure: 'Carousel d\'images accessible (clavier + aria).',
    data_nexai_id: 'gallery-2',
  },
  {
    id: 'reservation_cta_bandeau',
    niches: ['*'],
    nom: 'Bandeau CTA réservation',
    structure: 'Bandeau pleine largeur avec CTA de réservation/contact ultra visible.',
    data_nexai_id: 'reservation-cta',
  },
  {
    id: 'stats_bandeau',
    niches: ['*'],
    nom: 'Bandeau statistiques',
    structure: 'Chiffres systématiquement sourcés, jamais de compteur inventé (anti-slop).',
    data_nexai_id: 'stats-band',
  },
  {
    id: 'faq_accordeon',
    niches: ['*'],
    nom: 'FAQ accordéon',
    structure: '<details>/<summary> natif ou bouton + aria-expanded.',
    data_nexai_id: 'faq-item-N',
  },
  {
    id: 'footer_simple',
    niches: ['*'],
    nom: 'Footer — variante simple',
    structure: 'Liens légaux obligatoires (mentions légales, confidentialité, CGV si e-commerce).',
    data_nexai_id: 'footer-main',
  },
  {
    id: 'footer_multi_colonnes',
    niches: ['*'],
    nom: 'Footer — variante multi-colonnes',
    structure: 'Plusieurs colonnes de liens + liens légaux obligatoires.',
    data_nexai_id: 'footer-main',
  },
  {
    id: 'zone_intervention_carte',
    niches: ['*'],
    nom: 'Carte zone d\'intervention',
    structure: 'Carte géographique de la zone couverte (services locaux, santé, immobilier...).',
    data_nexai_id: 'zone-map',
  },
  {
    id: 'avis_google_carousel',
    niches: ['*'],
    nom: 'Carousel avis Google',
    structure: 'Carousel accessible d\'avis clients externes.',
    data_nexai_id: 'google-reviews',
  },
  {
    id: 'listing_biens_grid',
    niches: ['*'],
    nom: 'Grille de listing (biens/offres)',
    structure: 'Grille de fiches (biens immobiliers, offres, etc.) avec role="list"/"listitem".',
    data_nexai_id: 'listing-grid',
  },
  {
    id: 'formulaire_contact',
    niches: ['*'],
    nom: 'Formulaire de contact',
    structure: '<form> avec labels associés à chaque champ, honeypot caché, aria-live pour les erreurs. Compatible Schema LocalBusiness.',
    etats: 'default · focus · error (aria-invalid + message) · loading · success',
    responsive: 'Cibles ≥ 44 px sur tous les champs et boutons.',
    data_nexai_id: 'form-contact',
  },

  // ── Spécifiques par niche ──────────────────────────────────────────
  {
    id: 'grille_produits',
    niches: ['ecommerce_mode'],
    nom: 'Grille produits',
    structure: 'role="list" / role="listitem". Bouton "Ajouter" ≥ 44 px. Variantes en radiogroup accessible.',
    etats: 'default · hover carte · loading (skeleton) · empty (aucun produit)',
    responsive: 'Grille 1 colonne mobile → 2-4 colonnes desktop selon densité.',
    data_nexai_id: 'product-grid',
  },
  {
    id: 'fiche_produit',
    niches: ['ecommerce_mode'],
    nom: 'Fiche produit',
    structure: 'Schema Product + Offer + shippingDetails + hasMerchantReturnPolicy.',
    data_nexai_id: 'product-detail',
  },
  {
    id: 'panier_resume',
    niches: ['ecommerce_mode'],
    nom: 'Résumé panier',
    structure: 'Récapitulatif des articles sélectionnés, quantités, total.',
    data_nexai_id: 'cart-summary',
  },
  {
    id: 'table_tarifs',
    niches: ['tech_startup_saas'],
    nom: 'Table de tarifs',
    structure: 'Tiers de prix nommés par profil client, pricing visible (pas caché derrière un formulaire pour du SMB).',
    data_nexai_id: 'pricing-table',
  },
  {
    id: 'logos_clients_bandeau',
    niches: ['tech_startup_saas'],
    nom: 'Bandeau logos clients',
    structure: 'Logos clients + chiffres concrets, preuve sociale précoce.',
    data_nexai_id: 'logos-band',
  },
  {
    id: 'carte_menu',
    niches: ['restaurant_gastronomie'],
    nom: 'Carte / Menu',
    structure: 'Menu en HTML sémantique. Schema FoodEstablishment : servesCuisine, hasMenu, acceptsReservations, priceRange.',
    data_nexai_id: 'menu-card',
  },
  {
    id: 'grille_projets_filtrable',
    niches: ['portfolio_creatif'],
    nom: 'Grille de projets filtrable',
    structure: 'Grandes images, peu de texte. Filtres avec aria-pressed + live region.',
    data_nexai_id: 'projects-grid',
  },
  {
    id: 'grille_cours',
    niches: ['education_formation'],
    nom: 'Grille de cours/formations',
    structure: 'Liste de cours/formations avec niveau, durée, CTA inscription.',
    data_nexai_id: 'courses-grid',
  },
  {
    id: 'etudes_de_cas',
    niches: ['business_vitrine'],
    nom: 'Études de cas',
    structure: 'Cas clients détaillés : contexte, action, résultat mesurable.',
    data_nexai_id: 'case-studies',
  },
];
