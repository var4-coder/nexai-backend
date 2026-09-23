/**
 * Catalogue des pays servis par NexAI, avec indicatif téléphonique et langue
 * d'interface par défaut.
 *
 * Source unique de vérité : le frontend consomme cette liste via
 * GET /api/v1/textes/pays plutôt que de la dupliquer. Ajouter un pays ici le
 * rend disponible partout (inscription, abonnement, achat de crédits, retrait).
 *
 * La langue est un DÉFAUT déduit du pays, jamais une contrainte : le client
 * peut la changer à tout moment depuis Paramètres (PATCH /users/langue).
 */

export type Langue = 'fr' | 'en' | 'es' | 'pt' | 'ar';

/** Langues réellement proposées dans l'interface. */
export const LANGUES_SUPPORTEES: readonly Langue[] = ['fr', 'en', 'es', 'pt', 'ar'];

export const LANGUE_LABELS: Record<Langue, string> = {
  fr: 'Français',
  en: 'English',
  es: 'Español',
  pt: 'Português',
  ar: 'العربية',
};

export type Pays = {
  /** Code ISO 3166-1 alpha-2. */
  code: string;
  /** Nom affiché (en français, langue pivot de la plateforme). */
  nom: string;
  /** Indicatif téléphonique international, sans le "+". */
  indicatif: string;
  /** Langue d'interface proposée par défaut pour ce pays. */
  langue: Langue;
};

/**
 * Les 54 pays d'Afrique, puis les pays de la diaspora où NexAI est utilisable.
 * Triés par continent puis alphabétiquement pour que la liste reste lisible
 * dans un menu déroulant.
 */
export const PAYS: readonly Pays[] = [
  // ── Afrique ──────────────────────────────────────────────────────────
  { code: 'ZA', nom: 'Afrique du Sud', indicatif: '27', langue: 'en' },
  { code: 'DZ', nom: 'Algérie', indicatif: '213', langue: 'ar' },
  { code: 'AO', nom: 'Angola', indicatif: '244', langue: 'pt' },
  { code: 'BJ', nom: 'Bénin', indicatif: '229', langue: 'fr' },
  { code: 'BW', nom: 'Botswana', indicatif: '267', langue: 'en' },
  { code: 'BF', nom: 'Burkina Faso', indicatif: '226', langue: 'fr' },
  { code: 'BI', nom: 'Burundi', indicatif: '257', langue: 'fr' },
  { code: 'CM', nom: 'Cameroun', indicatif: '237', langue: 'fr' },
  { code: 'CV', nom: 'Cap-Vert', indicatif: '238', langue: 'pt' },
  { code: 'CF', nom: 'Centrafrique', indicatif: '236', langue: 'fr' },
  { code: 'KM', nom: 'Comores', indicatif: '269', langue: 'fr' },
  { code: 'CG', nom: 'Congo-Brazzaville', indicatif: '242', langue: 'fr' },
  { code: 'CD', nom: 'Congo (RDC)', indicatif: '243', langue: 'fr' },
  { code: 'CI', nom: 'Côte d’Ivoire', indicatif: '225', langue: 'fr' },
  { code: 'DJ', nom: 'Djibouti', indicatif: '253', langue: 'fr' },
  { code: 'EG', nom: 'Égypte', indicatif: '20', langue: 'ar' },
  { code: 'ER', nom: 'Érythrée', indicatif: '291', langue: 'en' },
  { code: 'SZ', nom: 'Eswatini', indicatif: '268', langue: 'en' },
  { code: 'ET', nom: 'Éthiopie', indicatif: '251', langue: 'en' },
  { code: 'GA', nom: 'Gabon', indicatif: '241', langue: 'fr' },
  { code: 'GM', nom: 'Gambie', indicatif: '220', langue: 'en' },
  { code: 'GH', nom: 'Ghana', indicatif: '233', langue: 'en' },
  { code: 'GN', nom: 'Guinée', indicatif: '224', langue: 'fr' },
  { code: 'GW', nom: 'Guinée-Bissau', indicatif: '245', langue: 'pt' },
  { code: 'GQ', nom: 'Guinée équatoriale', indicatif: '240', langue: 'es' },
  { code: 'KE', nom: 'Kenya', indicatif: '254', langue: 'en' },
  { code: 'LS', nom: 'Lesotho', indicatif: '266', langue: 'en' },
  { code: 'LR', nom: 'Libéria', indicatif: '231', langue: 'en' },
  { code: 'LY', nom: 'Libye', indicatif: '218', langue: 'ar' },
  { code: 'MG', nom: 'Madagascar', indicatif: '261', langue: 'fr' },
  { code: 'MW', nom: 'Malawi', indicatif: '265', langue: 'en' },
  { code: 'ML', nom: 'Mali', indicatif: '223', langue: 'fr' },
  { code: 'MA', nom: 'Maroc', indicatif: '212', langue: 'ar' },
  { code: 'MU', nom: 'Maurice', indicatif: '230', langue: 'fr' },
  { code: 'MR', nom: 'Mauritanie', indicatif: '222', langue: 'ar' },
  { code: 'MZ', nom: 'Mozambique', indicatif: '258', langue: 'pt' },
  { code: 'NA', nom: 'Namibie', indicatif: '264', langue: 'en' },
  { code: 'NE', nom: 'Niger', indicatif: '227', langue: 'fr' },
  { code: 'NG', nom: 'Nigeria', indicatif: '234', langue: 'en' },
  { code: 'UG', nom: 'Ouganda', indicatif: '256', langue: 'en' },
  { code: 'RW', nom: 'Rwanda', indicatif: '250', langue: 'en' },
  { code: 'ST', nom: 'Sao Tomé-et-Principe', indicatif: '239', langue: 'pt' },
  { code: 'SN', nom: 'Sénégal', indicatif: '221', langue: 'fr' },
  { code: 'SC', nom: 'Seychelles', indicatif: '248', langue: 'fr' },
  { code: 'SL', nom: 'Sierra Leone', indicatif: '232', langue: 'en' },
  { code: 'SO', nom: 'Somalie', indicatif: '252', langue: 'ar' },
  { code: 'SD', nom: 'Soudan', indicatif: '249', langue: 'ar' },
  { code: 'SS', nom: 'Soudan du Sud', indicatif: '211', langue: 'en' },
  { code: 'TZ', nom: 'Tanzanie', indicatif: '255', langue: 'en' },
  { code: 'TD', nom: 'Tchad', indicatif: '235', langue: 'fr' },
  { code: 'TG', nom: 'Togo', indicatif: '228', langue: 'fr' },
  { code: 'TN', nom: 'Tunisie', indicatif: '216', langue: 'ar' },
  { code: 'ZM', nom: 'Zambie', indicatif: '260', langue: 'en' },
  { code: 'ZW', nom: 'Zimbabwe', indicatif: '263', langue: 'en' },

  // ── Diaspora ─────────────────────────────────────────────────────────
  { code: 'DE', nom: 'Allemagne', indicatif: '49', langue: 'en' },
  { code: 'BE', nom: 'Belgique', indicatif: '32', langue: 'fr' },
  { code: 'BR', nom: 'Brésil', indicatif: '55', langue: 'pt' },
  { code: 'CA', nom: 'Canada', indicatif: '1', langue: 'fr' },
  { code: 'ES', nom: 'Espagne', indicatif: '34', langue: 'es' },
  { code: 'US', nom: 'États-Unis', indicatif: '1', langue: 'en' },
  { code: 'FR', nom: 'France', indicatif: '33', langue: 'fr' },
  { code: 'IT', nom: 'Italie', indicatif: '39', langue: 'en' },
  { code: 'PT', nom: 'Portugal', indicatif: '351', langue: 'pt' },
  { code: 'GB', nom: 'Royaume-Uni', indicatif: '44', langue: 'en' },
  { code: 'CH', nom: 'Suisse', indicatif: '41', langue: 'fr' },
];

const PAYS_PAR_CODE = new Map(PAYS.map((p) => [p.code, p]));

/** Pays connu ? (codes ISO en majuscules) */
export function isPaysSupporte(code?: string | null): boolean {
  return !!code && PAYS_PAR_CODE.has(code.toUpperCase());
}

/** Indicatif téléphonique d'un pays, ou null si inconnu. */
export function getIndicatif(code?: string | null): string | null {
  if (!code) return null;
  return PAYS_PAR_CODE.get(code.toUpperCase())?.indicatif ?? null;
}

/**
 * Langue d'interface à appliquer par défaut pour un pays.
 * Retombe sur le français, langue pivot de la plateforme, si le pays est
 * inconnu ou absent — jamais d'erreur : une langue par défaut vaut toujours
 * mieux qu'une inscription bloquée.
 */
export function langueParDefautPourPays(code?: string | null): Langue {
  if (!code) return 'fr';
  return PAYS_PAR_CODE.get(code.toUpperCase())?.langue ?? 'fr';
}

/** Normalise une valeur reçue du client en langue supportée. */
export function normaliserLangue(valeur?: string | null): Langue | null {
  if (!valeur) return null;
  const v = valeur.toLowerCase().slice(0, 2) as Langue;
  return LANGUES_SUPPORTEES.includes(v) ? v : null;
}

/**
 * Consigne à injecter dans les prompts IA pour que le contenu produit (sites,
 * scripts vidéo, réponses du Coach business) sorte dans la langue du client.
 *
 * Volontairement impérative et placée en fin de prompt : les modèles suivent
 * mieux une contrainte de langue énoncée en dernier.
 */
export function consigneLangue(langue: Langue): string {
  const noms: Record<Langue, string> = {
    fr: 'français',
    en: 'anglais (English)',
    es: 'espagnol (Español)',
    pt: 'portugais (Português)',
    ar: 'arabe (العربية)',
  };
  return `LANGUE DE SORTIE OBLIGATOIRE : rédige absolument tout le contenu destiné à l'utilisateur final en ${noms[langue]}. Cela inclut les titres, paragraphes, boutons, libellés de formulaire, messages et métadonnées. N'utilise aucune autre langue, même partiellement.`;
}
