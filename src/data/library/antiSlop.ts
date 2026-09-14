/**
 * Librairie interne — checklist anti-slop (source : NexAI_Source_de_Verite_Finale.pdf, B.5).
 * Second secours quand MongoDB (collection `library_anti_slop`) est indisponible.
 */

export const INTERNAL_ANTI_SLOP = {
  items: [
    'Dégradé violet-bleu par défaut, glassmorphism / blur sans raison.',
    'Illustrations blob génériques, emoji comme illustrations.',
    'Boutons pill sans hiérarchie, radius pill partout.',
    'Compteurs de statistiques inventées ou non sourcées.',
    'Gradients multicolores non motivés.',
    'Photos stock ultra-clichés (poignée de main, sourire figé).',
    'Typographie excessivement display, plus de 2 polices, une seule graisse bold.',
    'Sections features à 6 icônes identiques, grille 3 colonnes répétée sans variation.',
    'Hero centré sans asymétrie, padding vertical identique partout.',
    'Copy générique ("solutions innovantes", "excellence", "au service de votre réussite").',
    'Animations non liées à une intention, fade-in-up identique partout, animations non neutralisées par prefers-reduced-motion.',
    'Site interchangeable en changeant simplement le logo et les couleurs.',
  ],
  formulations_interdites: [
    'solutions innovantes',
    'excellence opérationnelle',
    'partenaire de confiance',
    'à la pointe de la technologie',
    'Nos services (titre générique)',
  ],
};
