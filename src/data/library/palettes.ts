/**
 * Librairie interne — palettes de couleurs par niche (source : NexAI_Source_de_Verite_Finale.pdf, B.4).
 * Second secours quand MongoDB (collection `library_palettes`) est indisponible.
 */

export interface LibraryPaletteDoc {
  niche: string;
  primaire: string;
  accent: string;
  secondaire?: string;
  surface?: string;
  texte: string;
  succes?: string;
  erreur?: string;
  warning?: string;
  notes?: string;
}

export const INTERNAL_PALETTES: LibraryPaletteDoc[] = [
  {
    niche: 'tech_startup_saas',
    primaire: '#0B1F3A',
    accent: '#3B82F6',
    surface: '#F1F5F9',
    texte: '#0F172A',
    succes: '#16A34A',
    erreur: '#DC2626',
    warning: '#D97706',
    notes: 'Contraste texte/primaire ≥ 4.5:1.',
  },
  {
    niche: 'restaurant_gastronomie',
    primaire: '#3A0D0D',
    accent: '#C0392B',
    secondaire: '#E8743B',
    surface: '#FBEFD6',
    texte: '#1C1917',
    succes: '#4C9A2A',
    notes: 'Tons chauds, appétissants. Éviter les bleus froids.',
  },
  {
    niche: 'portfolio_creatif',
    primaire: '#101010',
    accent: '#FFD300',
    secondaire: '#7C6DFA',
    surface: '#F8F8F8',
    texte: '#171717',
    notes: 'Asymétrie, radius quasi nul, grandes images. Minimaliste. Accent alternatif indigo #7C6DFA.',
  },
  {
    niche: 'ecommerce_mode',
    primaire: '#111827',
    accent: '#BE185D',
    secondaire: '#0F766E',
    surface: '#FAFAF9',
    texte: '#1C1917',
    notes: 'Bordures #E7E5E4. Contraste fort sur le CTA "Ajouter au panier". Accent alternatif teal #0F766E.',
  },
  {
    niche: 'sante_bienetre',
    primaire: '#1F3D1A',
    accent: '#4C9A2A',
    secondaire: '#8FAF8A',
    surface: '#FBF6E3',
    texte: '#14532D',
    notes: 'Tons biophiliques, rassurants.',
  },
  {
    niche: 'immobilier_architecture',
    primaire: '#1E3A5F',
    accent: '#2563EB',
    secondaire: '#64748B',
    surface: '#F8FAFC',
    texte: '#0F172A',
    notes: 'Professionnel, confiance, prêt pour Schema LocalBusiness.',
  },
  {
    niche: 'business_vitrine',
    primaire: '#1E3A5F',
    accent: '#2563EB',
    secondaire: '#64748B',
    surface: '#F8FAFC',
    texte: '#0F172A',
    notes: 'Professionnel, confiance, prêt pour Schema LocalBusiness.',
  },
  {
    niche: 'services_locaux',
    primaire: '#1E3A5F',
    accent: '#2563EB',
    secondaire: '#64748B',
    surface: '#F8FAFC',
    texte: '#0F172A',
    notes: 'Professionnel, confiance, prêt pour Schema LocalBusiness.',
  },
  {
    niche: 'hotellerie_evenementiel',
    primaire: '#1C1917',
    accent: '#B45309',
    surface: '#FAF7F2',
    texte: '#292524',
    notes: 'Chaleureux premium.',
  },
  {
    niche: 'education_formation',
    primaire: '#1C1917',
    accent: '#7C3AED',
    surface: '#FAF7F2',
    texte: '#292524',
    notes: 'Dynamique.',
  },
];
