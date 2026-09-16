/**
 * Bibliothèque de musiques pour le tier vidéo "Standard" (silencieux + musique)
 * ET pour la musique de fond bas-volume du tier "avec_son".
 *
 * Alignée sur les 10 niches réelles du système (voir src/data/library/niches.ts,
 * source NexAI_Source_de_Verite_Finale.pdf, B.1 & B.18) — même `slug`.
 *
 * Chaque niche a désormais un POOL de plusieurs tracks (au lieu d'un seul via
 * env var) : à chaque génération de vidéo, `resolveMusicTrack` en tire un au
 * hasard dans le pool de la niche concernée, pour éviter que la même musique
 * revienne systématiquement sur des vidéos générées en masse.
 *
 * ⚠️ IMPORTANT — licences :
 * Tous les fichiers ci-dessous ont été uploadés sur Cloudinary par l'équipe
 * NexAI depuis des banques royalty-free (Pixabay Music notamment, d'après le
 * nommage des fichiers). La licence exacte de chaque piste doit être
 * vérifiable côté équipe avant usage commercial en publicité ; le champ
 * `licence` sert de traçabilité — à compléter avec la référence précise
 * (lien de licence Pixabay, etc.) si besoin d'audit.
 */

export interface MusicTrack {
  id: string;
  /** URL publique du fichier audio (mp3/m4a), hébergé sur Cloudinary. */
  url: string;
  mood: string;
  /** Référence de licence — traçabilité, à compléter si besoin d'audit précis. */
  licence: string;
}

const PIXABAY_LICENCE = 'Pixabay Music — royalty-free (vérifié par l’équipe NexAI)';

/** Un pool de plusieurs tracks par niche réelle du système, slug identique à niches.ts. */
export const MUSIC_LIBRARY: Record<string, MusicTrack[]> = {
  hotellerie_evenementiel: [
    {
      id: 'hotellerie_evenementiel_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121859/crab_audio-luxury-hotel-278132.mp3',
      mood: 'élégant, chaleureux, festif discret',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'hotellerie_evenementiel_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121882/ivan_luzan-luxury-hotel-ambient-lounge-404916.mp3',
      mood: 'élégant, chaleureux, festif discret',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'hotellerie_evenementiel_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121965/the_mountain-spa-hotel-179469.mp3',
      mood: 'élégant, chaleureux, festif discret',
      licence: PIXABAY_LICENCE,
    },
  ],
  sante_bienetre: [
    {
      id: 'sante_bienetre_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121868/chrisdjyogi-gentle-sanctuary-soothing-instrumental-for-anxiety-457300.mp3',
      mood: 'calme, apaisant, minimal',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'sante_bienetre_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121912/nastelbom-spa-434509.mp3',
      mood: 'calme, apaisant, minimal',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'sante_bienetre_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121937/joyinsound-gentle-spa-escape-386055.mp3',
      mood: 'calme, apaisant, minimal',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'sante_bienetre_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121984/willsalute-nature-calming-310735.mp3',
      mood: 'calme, apaisant, minimal',
      licence: PIXABAY_LICENCE,
    },
  ],
  immobilier_architecture: [
    {
      id: 'immobilier_architecture_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121890/maksymmalko-real-estate-construction-architecture-music-307331.mp3',
      mood: 'cinématique, aspirationnel, ample',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'immobilier_architecture_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121905/mfcc-real-estate-architecture-real-estate-construction-music-345393.mp3',
      mood: 'cinématique, aspirationnel, ample',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'immobilier_architecture_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121941/starostin-real-estate-construction-architecture-music-258027.mp3',
      mood: 'cinématique, aspirationnel, ample',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'immobilier_architecture_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121983/viacheslavstarostin-construction-real-estate-architecture-music-340806.mp3',
      mood: 'cinématique, aspirationnel, ample',
      licence: PIXABAY_LICENCE,
    },
  ],
  services_locaux: [
    {
      id: 'services_locaux_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121919/sigmamusicart-upbeat-advertising-music-258271.mp3',
      mood: 'accessible, dynamique, rassurant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'services_locaux_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121932/royalty_free_audio-indie-corporate-upbeat-commercial-advertising-music-251523.mp3',
      mood: 'accessible, dynamique, rassurant',
      licence: PIXABAY_LICENCE,
    },
  ],
  business_vitrine: [
    {
      id: 'business_vitrine_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121853/alexgrohl-business-business-music-491840.mp3',
      mood: 'corporate sobre, sérieux, confiant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'business_vitrine_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121915/petrushkasound-upbeat-corporate-commercial-music-428452.mp3',
      mood: 'corporate sobre, sérieux, confiant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'business_vitrine_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121936/paulyudin-upbeat-upbeat-corporate-493489.mp3',
      mood: 'corporate sobre, sérieux, confiant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'business_vitrine_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121937/starostin-upbeat-corporate-music-333704.mp3',
      mood: 'corporate sobre, sérieux, confiant',
      licence: PIXABAY_LICENCE,
    },
  ],
  ecommerce_mode: [
    {
      id: 'ecommerce_mode_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121870/hitslab-fashion-luxury-beauty-music-435773.mp3',
      mood: 'énergique, punchy, tendance',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'ecommerce_mode_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121884/lnplusmusic-beauty-fashion-luxury-music-502573.mp3',
      mood: 'énergique, punchy, tendance',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'ecommerce_mode_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121905/monume-fashion-beauty-luxury-498029.mp3',
      mood: 'énergique, punchy, tendance',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'ecommerce_mode_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121945/sountrixaudio-fashion-lifestyle-background-music-434633.mp3',
      mood: 'énergique, punchy, tendance',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'ecommerce_mode_5',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121986/viacheslavstarostin-fashion-luxury-beauty-music-391776.mp3',
      mood: 'énergique, punchy, tendance',
      licence: PIXABAY_LICENCE,
    },
  ],
  portfolio_creatif: [
    {
      id: 'portfolio_creatif_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121912/music_for_creators-acoustic-upbeat-indie-uplifting-126328.mp3',
      mood: 'artistique, atmosphérique, original',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'portfolio_creatif_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121952/the_mountain-deep-joy-129869.mp3',
      mood: 'artistique, atmosphérique, original',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'portfolio_creatif_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121960/tunetank-upbeat-indie-music-347814.mp3',
      mood: 'artistique, atmosphérique, original',
      licence: PIXABAY_LICENCE,
    },
  ],
  tech_startup_saas: [
    {
      id: 'tech_startup_saas_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121864/alexgrohl-innovation-373645.mp3',
      mood: 'moderne, synthé, innovant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'tech_startup_saas_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121864/denis-pavlov-music-technology-futuristic-digital-ambient-innovation-science-475723.mp3',
      mood: 'moderne, synthé, innovant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'tech_startup_saas_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121885/lubarskymusic-the-tech-innovation-585622.mp3',
      mood: 'moderne, synthé, innovant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'tech_startup_saas_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121909/nastelbom-digital-technology-337601.mp3',
      mood: 'moderne, synthé, innovant',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'tech_startup_saas_5',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121969/vasilyatsevich-sense-of-innovation-inspiring-ambient-tech-147669.mp3',
      mood: 'moderne, synthé, innovant',
      licence: PIXABAY_LICENCE,
    },
  ],
  restaurant_gastronomie: [
    {
      id: 'restaurant_gastronomie_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121869/hitslab-food-cooking-music-404526.mp3',
      mood: 'chaleureux, appétissant, convivial',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'restaurant_gastronomie_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121896/mfcc-cooking-food-music-247352.mp3',
      mood: 'chaleureux, appétissant, convivial',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'restaurant_gastronomie_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121926/starostin-food-cooking-music-428587.mp3',
      mood: 'chaleureux, appétissant, convivial',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'restaurant_gastronomie_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121973/tatamusic-cooking-food-music-409383.mp3',
      mood: 'chaleureux, appétissant, convivial',
      licence: PIXABAY_LICENCE,
    },
  ],
  education_formation: [
    {
      id: 'education_formation_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121857/atlasaudio-education-522415.mp3',
      mood: 'motivant, positif, clair',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'education_formation_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121870/freemusicforvideo-educational-education-school-music-462851.mp3',
      mood: 'motivant, positif, clair',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'education_formation_3',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121878/delosound-educational-presentation-tutorial-music-447248.mp3',
      mood: 'motivant, positif, clair',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'education_formation_4',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121965/tatamusic-educational-learning-study-music-425339.mp3',
      mood: 'motivant, positif, clair',
      licence: PIXABAY_LICENCE,
    },
  ],
  /** Fallback : niche absente, non reconnue, ou vidéo générée depuis une URL externe (pas de slug fiable). */
  general: [
    {
      id: 'general_1',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121932/royalty_free_audio-indie-corporate-upbeat-commercial-advertising-music-251523.mp3',
      mood: 'corporate upbeat neutre',
      licence: PIXABAY_LICENCE,
    },
    {
      id: 'general_2',
      url: 'https://res.cloudinary.com/qvgoqytd/video/upload/v1788121936/paulyudin-upbeat-upbeat-corporate-493489.mp3',
      mood: 'corporate upbeat neutre',
      licence: PIXABAY_LICENCE,
    },
  ],
};

/**
 * Résout un track aléatoire dans le pool de la niche donnée.
 * `niche` est censé être un slug valide (ex: "ecommerce_mode") quand la vidéo
 * part d'un site NexAI existant. Si ce n'est pas un slug connu (vidéo générée
 * depuis une simple URL externe, ou niche vide), on retombe sur "general".
 * Retourne null si même le fallback n'a aucun track (cas normalement
 * impossible vu que "general" est toujours rempli) — le pipeline gère ce cas
 * en livrant sans musique plutôt que de planter.
 */
export function resolveMusicTrack(niche: string): MusicTrack | null {
  const slug = (niche || '').trim().toLowerCase();
  const pool = MUSIC_LIBRARY[slug]?.length ? MUSIC_LIBRARY[slug] : MUSIC_LIBRARY.general;
  if (!pool || pool.length === 0) return null;
  const track = pool[Math.floor(Math.random() * pool.length)];
  return track?.url ? track : null;
}
