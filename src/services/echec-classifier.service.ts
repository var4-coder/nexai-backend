import type { IncidentGravite } from '@/models/PlatformAlert';

/**
 * Classification d'un échec technique, pour décider qui doit agir.
 *
 * Règle directrice : seul ce que le système sait régler seul reste
 * silencieux. Tout problème sérieux est signalé à l'administrateur — en
 * particulier les pannes du système NexAI lui-même, que personne d'autre ne
 * peut détecter.
 *
 * Fable, l'agent qualité, juge et relance des générations : il ne peut ni
 * renouveler une clé, ni recharger un compte fournisseur, ni corriger un bug.
 * Ces cas relèvent obligatoirement d'une intervention humaine.
 */
export type CategorieEchec =
  | 'configuration'
  | 'fournisseur_indisponible'
  | 'surcharge_passagere'
  | 'deploiement'
  | 'bug_interne';

export interface EchecClasse {
  categorie: CategorieEchec;
  /**
   * Qui doit s'en occuper : 'fable' si les agents savent la traiter seuls,
   * 'serieuse' si seule une intervention humaine peut la régler.
   */
  responsable: 'fable' | 'serieuse';
  /** Faut-il alerter l'administrateur ? */
  alerter: boolean;
  gravite: IncidentGravite;
  /** Explication courte, lisible par l'administrateur. */
  libelle: string;
}

function texteDe(err: unknown): string {
  if (err instanceof Error) return `${err.message} ${(err as { statusCode?: number }).statusCode ?? ''}`;
  return String(err ?? '');
}

export function classerEchec(err: unknown, contexte?: string): EchecClasse {
  const t = texteDe(err).toLowerCase();

  // ── Configuration : rien ne fonctionnera tant que ce n'est pas réglé ──
  if (
    /manquante|api[_ ]?key|clé|unauthorized|invalid[_ ]?api|authentication|\b401\b|\b403\b/.test(t) ||
    /insufficient|quota|credit balance|billing|payment required|\b402\b/.test(t)
  ) {
    return {
      categorie: 'configuration',
      responsable: 'serieuse',
      alerter: true,
      gravite: 'critique',
      libelle:
        'Clé API invalide ou crédits épuisés chez un fournisseur. Aucune génération ne pourra aboutir tant que ce n’est pas réglé.',
    };
  }

  // ── Surcharge passagère : un nouvel essai suffit, inutile d'alerter ──
  if (/saturé|busy|\b429\b|rate limit|too many requests|timeout|timed out|etimedout|econnreset/.test(t)) {
    return {
      categorie: 'surcharge_passagere',
      responsable: 'fable',
      alerter: false,
      gravite: 'faible',
      libelle: 'Surcharge passagère d’un fournisseur — nouvel essai automatique.',
    };
  }

  // ── Fournisseur en panne ──
  if (/\b50[0234]\b|service unavailable|bad gateway|overloaded|fournisseur|falai|alexya|anthropic|xai/.test(t)) {
    return {
      categorie: 'fournisseur_indisponible',
      // Fable relance automatiquement quand le fournisseur revient : pas
      // d'email, l'administrateur la voit dans « Pannes gérées par Fable ».
      responsable: 'fable',
      alerter: true,
      gravite: 'moyenne',
      libelle: 'Un fournisseur d’IA ne répond pas correctement. Les générations concernées échouent en attendant.',
    };
  }

  // ── Déploiement : un site client ne peut pas être mis en ligne ──
  if (/netlify|deploy|déploiement|dns|custom_domain|domain/.test(t) || contexte === 'deploiement') {
    return {
      categorie: 'deploiement',
      responsable: 'serieuse',
      alerter: true,
      gravite: 'critique',
      libelle: 'Un site client ne peut pas être mis en ligne.',
    };
  }

  // ── Tout le reste : une erreur du système NexAI lui-même ──
  //
  // Par défaut on ALERTE. Un échec qu'on ne sait pas classer est
  // précisément celui qui mérite un regard humain.
  return {
    categorie: 'bug_interne',
    responsable: 'serieuse',
    alerter: true,
    gravite: 'critique',
    libelle: 'Erreur inattendue du système NexAI.',
  };
}
