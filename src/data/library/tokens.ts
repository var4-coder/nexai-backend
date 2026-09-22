/**
 * Librairie interne — tokens globaux (source : NexAI_Source_de_Verite_Finale.pdf, B.3).
 * Second secours quand MongoDB (collection `library_tokens`) est indisponible.
 */

export const INTERNAL_TOKENS = {
  _id: 'tokens_globaux',
  espacement: {
    base: '16px',
    echelle: {
      xs: { rem: '0.25rem', px: '4px', usage: 'Gaps micro, border offset' },
      sm: { rem: '0.5rem', px: '8px', usage: 'Padding boutons, gaps liste' },
      md: { rem: '1rem', px: '16px', usage: 'Padding cartes, gaps section' },
      lg: { rem: '1.5rem', px: '24px', usage: 'Padding sections, gaps grille' },
      xl: { rem: '2rem', px: '32px', usage: 'Marges sections, hero padding' },
      '2xl': { rem: '3rem', px: '48px', usage: 'Séparation blocs majeurs' },
      '3xl': { rem: '4rem', px: '64px', usage: 'Hero vertical, page margins' },
    },
  },
  typographie: {
    base_px: 16,
    ratio_desktop: 1.25,
    ratio_mobile: 1.15,
    line_height_titres: '1.15–1.25',
    line_height_corps: '1.5–1.65',
    poids: { body: 400, labels: 500, subheads: 600, headings: 700 },
    font_display_swap: true,
    echelle: {
      display_h1: { desktop: '2.5–3rem (40–48px)', mobile: '1.75–2rem', line_height: 1.15, poids: 700 },
      h2: { desktop: '1.75–2rem', mobile: '1.5rem', line_height: 1.2, poids: 700 },
      h3: { desktop: '1.25–1.5rem', mobile: '1.125rem', line_height: 1.25, poids: 600 },
      body: { desktop: '1rem (16px)', mobile: '1rem', line_height: '1.5–1.65', poids: 400 },
      small_caption: { desktop: '0.875rem', mobile: '0.8125rem', line_height: 1.4, poids: '400–500' },
    },
  },
  grille: {
    colonnes: [4, 8, 12],
    gouttieres: '16–24px',
    conteneur_max_width: '1200px',
  },
  radius: { sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' },
  ombres: {
    sm: '0 1px 2px rgb(0 0 0 / 0.05)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
  },
  z_index: { dropdown: 1000, sticky: 1100, modal: 1300, toast: 1400 },
  motion: {
    duree: '150–300ms',
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    prefers_reduced_motion: 'duration 0.01ms',
  },
  a11y: {
    cible_min_px: '24×24 (recommandé 44×44)',
    focus_ring: '2–3px solid, contraste ≥ 3:1',
    contraste_texte_normal: '≥ 4.5:1',
    contraste_texte_large: '≥ 3:1',
  },
  spacing_usage: 'Échelle 8/16px stricte, aucune valeur magique en dur.',
  font_size: 'Base 16px, ratio 1.25 desktop / 1.15 mobile, font-display: swap obligatoire.',
  performance: {
    LCP_max_s: 2.5,
    INP_max_ms: 200,
    CLS_max: 0.1,
    image_lcp: 'loading="eager" + fetchpriority="high"',
    critical_css_max_ko: 14,
  },
};
