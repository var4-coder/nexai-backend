import { videoQueue, siteQueue } from '@/jobs/queue';

/**
 * Estimation d'attente affichée au client pendant une génération.
 *
 * Objectif : remplacer un écran qui tourne sans rien dire par une information
 * compréhensible. Un client sans repère croit à une panne au bout de 90
 * secondes ; le même client, avec une estimation honnête, patiente
 * tranquillement.
 *
 * Le message ne mentionne jamais l'infrastructure (files techniques,
 * fournisseurs, concurrence, serveurs) : il parle de production en cours et de
 * temps restant, ce qui est vrai et suffisant.
 */

/** Durée moyenne observée d'une génération, en secondes. */
const DUREE_MOYENNE_SECONDES: Record<string, number> = {
  site: 5 * 60,
  video_30s: 3 * 60,
  video_60s: 5 * 60,
  video_120s: 9 * 60,
};

/**
 * Seuil au-delà duquel on signale explicitement que d'autres créations sont
 * en cours. En dessous, l'annoncer inquiéterait sans raison ; au-dessus, ne
 * rien dire laisserait croire à un blocage.
 */
const SEUIL_MENTION_FILE_SECONDES = 5 * 60;

export type EstimationAttente = {
  /** Secondes restantes estimées, pour un compte à rebours réel côté client. */
  secondesRestantes: number;
  /** Nombre de créations traitées avant celle-ci (0 si aucune). */
  devant: number;
  /** Titre à afficher. */
  titre: string;
  /** Texte d'accompagnement. */
  message: string;
};

function dureeReference(kind: 'site' | 'video', format?: string): number {
  if (kind === 'site') return DUREE_MOYENNE_SECONDES.site;
  return DUREE_MOYENNE_SECONDES[`video_${format ?? '30s'}`] ?? DUREE_MOYENNE_SECONDES.video_30s;
}

/**
 * Calcule l'attente estimée d'une génération.
 *
 * `demarreeIlYaSecondes` permet de décompter le temps déjà écoulé quand la
 * génération est déjà en cours, pour que le compte à rebours soit juste.
 */
export async function estimerAttente(params: {
  kind: 'site' | 'video';
  format?: string;
  /** true si le traitement a réellement démarré (pas seulement mis en file). */
  enCours: boolean;
  demarreeIlYaSecondes?: number;
}): Promise<EstimationAttente> {
  const reference = dureeReference(params.kind, params.format);

  // Nombre de créations en attente devant celle-ci. En cas d'indisponibilité
  // de la file, on n'invente rien : on considère qu'il n'y a personne devant.
  let devant = 0;
  if (!params.enCours) {
    try {
      const queue = params.kind === 'video' ? videoQueue : siteQueue;
      devant = await queue.getWaitingCount();
    } catch {
      devant = 0;
    }
  }

  const ecoule = params.enCours ? params.demarreeIlYaSecondes ?? 0 : 0;
  const restantPropre = Math.max(30, reference - ecoule);
  // Les créations qui précèdent ne sont pas traitées une par une : plusieurs
  // avancent de front. On compte donc une fraction de leur durée.
  const attenteDevant = devant > 0 ? Math.ceil((devant * reference) / 2) : 0;
  const secondesRestantes = restantPropre + attenteDevant;

  const quoi = params.kind === 'site' ? 'votre site' : 'votre vidéo';
  const titre =
    params.kind === 'site' ? 'Création de votre site en cours' : 'Création de votre vidéo en cours';

  if (secondesRestantes > SEUIL_MENTION_FILE_SECONDES && devant > 0) {
    return {
      secondesRestantes,
      devant,
      titre,
      message:
        `File en attente : d'autres commandes sont en cours, veuillez patienter un peu plus. ` +
        `Notre IA travaille sur ${quoi}.`,
    };
  }

  return {
    secondesRestantes,
    devant,
    titre,
    message: `Notre IA travaille sur ${quoi}.`,
  };
}
