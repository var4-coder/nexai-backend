/**
 * Textes client FIGÉS — Architecture v6, sections 7, 15 et 17.
 *
 * Ces libellés ont été validés mot pour mot avec le porteur de projet.
 * Ils ne doivent JAMAIS être reformulés, ni par une IA, ni au fil des
 * refactorisations : ils portent des engagements commerciaux précis et des
 * formulations pensées pour la conversion.
 *
 * Source unique volontaire : backend ET frontend lisent ces constantes,
 * pour qu'une correction ne puisse jamais s'appliquer d'un seul côté.
 */

// ══════════════════════════════════════════════════════════════════
// APERÇU DE SITE (section 7)
// ══════════════════════════════════════════════════════════════════

/**
 * Cas NORMAL — le site est correct, simplement pas encore publié.
 * Ne JAMAIS employer le mot « démo » ici : le client a un vrai site, pas
 * une maquette jetable.
 */
export const APERCU_CAS_NORMAL =
  "Votre site n'est pas encore en ligne. Vous seul le voyez. Passez à l'abonnement pour publier votre site. Vous pouvez avoir une meilleure version de votre site en cliquant sur l'option Améliorer. Cette option est disponible uniquement en abonnement.";

/** Légendes sous les deux boutons de l'écran d'aperçu. */
export const APERCU_BOUTON_AMELIORER = 'Améliorer — meilleure version grâce à l\u2019IA.';
export const APERCU_BOUTON_METTRE_EN_LIGNE = 'Mettre en ligne — visible sur internet.';

/**
 * Cas CASSÉ uniquement — le résultat n'a pas atteint la qualité attendue
 * malgré les réparations. Le site est livré quand même (jamais 0 aperçu),
 * avec ce texte à la place du texte normal.
 */
export const APERCU_CAS_CASSE =
  "Cet aperçu n'est pas encore prêt à être publié. Passez à un abonnement pour obtenir une meilleure version de votre site et le mettre en ligne.";

// ══════════════════════════════════════════════════════════════════
// VERROUS D'ABONNEMENT — visibles partout, jamais cachés
// Principe : le client voit l'option, comprend sa valeur, et sait
// exactement quel abonnement la débloque. Jamais un simple refus sec.
// ══════════════════════════════════════════════════════════════════

export const VERROU_QUALITE_PREMIUM =
  "La qualité Premium utilise notre IA la plus avancée pour un design, un branding et un référencement (SEO) dignes d'une agence professionnelle. Réservée aux abonnements payants.";

export const VERROU_MISE_EN_LIGNE =
  "La mise en ligne rend votre site accessible publiquement à l'adresse de votre choix. Elle coûte 15 crédits. L'hébergement et le certificat de sécurité sont inclus avec votre abonnement. Réservée aux abonnements payants.";

export const VERROU_VIDEO_IA =
  "Générez des vidéos publicitaires professionnelles en 4K, avec avatar IA ou voix off, prêtes à publier en quelques minutes. Disponible dès l'abonnement Créateur+.";

export const VERROU_ACHAT_CREDITS =
  "Les packs de crédits vous permettent de générer plus de sites, logos et vidéos sans attendre votre renouvellement mensuel. Disponible dès votre abonnement.";

export const VERROU_ESPACE_AGENCE =
  "L'Espace Agence vous permet de gérer plusieurs sites clients depuis un seul compte : suivi, statistiques et modification rapide des textes, sans repasser par le chat IA. Réservé aux abonnements Agence et Pro Max.";

export const VERROU_MINI_FILM =
  'Le mode Mini-film/série est réservé au plan Pro Max — idéal pour les créateurs de contenu qui publient des formats longs sur les réseaux sociaux.';

// ══════════════════════════════════════════════════════════════════
// ANCIENNES VIDÉOS DE TEST — comptes d'essai antérieurs
//
// Le test vidéo de l'essai gratuit n'est plus proposé : il est remplacé par
// la galerie d'exemples, visible par tous. Ces textes ne servent plus qu'aux
// vidéos de test déjà présentes en base, dont le téléchargement reste
// verrouillé.
// ══════════════════════════════════════════════════════════════════

/** Affiché sous une ancienne vidéo de test d'essai gratuit. */
export const VIDEO_TEST_INCITATION =
  'Cette vidéo a été générée pendant votre essai gratuit. Abonnez-vous dès Créateur+ pour créer vos propres publicités : formats 20 s, 30 s et 60 s, et mini-films de 2 minutes avec Pro Max.';

/** Remplace le bouton de téléchargement, verrouillé sur ces vidéos. */
export const VIDEO_TEST_TELECHARGEMENT_VERROUILLE =
  'Abonnez-vous pour créer et télécharger vos propres vidéos publicitaires.';

// ══════════════════════════════════════════════════════════════════
// BANDEAUX D'ORIENTATION VERS L'ASSISTANCE (section 15)
// Affichés UNE SEULE FOIS aux moments clés, jamais en pop-up répété.
// ══════════════════════════════════════════════════════════════════

export const BANDEAU_BIENVENUE_ESSAI =
  "Bienvenue sur NexAI ! Vous démarrez votre essai gratuit de 7 jours avec 15 crédits offerts. À la moindre question, un doute ou une difficulté, l'Assistance NexAI est disponible à tout moment depuis le menu — n'hésitez pas à la solliciter.";

/** `planNom` : libellé commercial du plan (« Créateur+ », « Pro Max »…). */
export function bandeauAbonnementActif(planNom: string): string {
  return `Merci, votre abonnement ${planNom} est bien actif ! Pour toute question sur vos nouvelles fonctionnalités, l'Assistance NexAI reste disponible à tout moment depuis le menu.`;
}

// ══════════════════════════════════════════════════════════════════
// MÉTHODE DE RETRAIT (section 12)
// ══════════════════════════════════════════════════════════════════

export const RETRAIT_COMPTE_NEXAI =
  "Les paiements de vos visiteurs sont collectés par NexAI, qui vous reverse ensuite vos gains sur le moyen que vous choisissez (Mobile Money, USDT BEP-20 ou BTC). Pratique si vous n'avez pas encore votre propre compte marchand.";

export const RETRAIT_LIEN_PERSONNEL =
  "Vos visiteurs paient directement sur votre propre lien de paiement. L'argent arrive immédiatement sur votre compte — NexAI n'intervient à aucun moment dans cet encaissement.";

// ══════════════════════════════════════════════════════════════════
// HUB NexAI WEB (section 5) — les crédits s'affichent SUR LE BOUTON,
// jamais dans le texte descriptif.
// ══════════════════════════════════════════════════════════════════

export const HUB_INTRO =
  'Les options affichées dépendent de votre abonnement. Passez à une offre supérieure pour débloquer les autres.';

export const HUB_TROUVER_BUSINESS =
  "Pas encore d'idée ? Le coach vous propose une activité et un plan clair pour démarrer.";

export const HUB_CREER_LOGO =
  'Un logo professionnel pour votre marque, réutilisable sur tous vos sites.';

export const HUB_CREER_SITE =
  'NexAI Web crée votre site et vous montre l\u2019aperçu avant sa mise en ligne.';

// ══════════════════════════════════════════════════════════════════
// ATTENTE DE GÉNÉRATION
// ══════════════════════════════════════════════════════════════════

/**
 * Écran d'attente pendant une génération.
 *
 * Deux niveaux, selon l'estimation réelle :
 *  - sous 5 minutes : on annonce simplement la préparation et le temps
 *    restant. Mentionner une file d'attente créerait une inquiétude
 *    inutile pour quelques minutes.
 *  - au-delà de 5 minutes : on explique qu'il y a des commandes en cours.
 *    Sans cette explication, le client croit à une panne et relance.
 *
 * Le compte à rebours affiché doit être RÉEL et décroître : une estimation
 * figée ou fantaisiste se retourne contre nous dès le premier dépassement.
 */
export const ATTENTE_VIDEO_TITRE = 'Création de votre vidéo en cours';
export const ATTENTE_VIDEO_SOUS_TITRE =
  'Notre IA travaille sur votre publicité.';

export const ATTENTE_SITE_TITRE = 'Création de votre site en cours';
export const ATTENTE_SITE_SOUS_TITRE = 'Notre IA construit votre site. Merci de patienter, cela peut prendre jusqu’à 10 minutes.';

/** Échec technique bloquant — pas de reprise automatique. */
export const SITE_PANNE_BLOQUANTE =
  'Cette création n’a pas abouti à cause d’une panne technique de notre côté. Nous la corrigeons. Vos crédits restent attachés à cette commande : vous pourrez relancer gratuitement dès que le service sera rétabli. En attendant, vous pouvez conserver ou supprimer cet essai.';

/** Reprise automatique déjà tentée, relance gratuite ouverte après 30 min. */
export const SITE_RELANCE_GRATUITE_ATTENTE =
  'La première tentative n’a pas abouti. Une nouvelle création gratuite sera disponible dans 30 minutes. Vos crédits restent attachés à cette commande. Vous pouvez aussi supprimer cet essai et revenir plus tard.';

export const SITE_RELANCE_GRATUITE_PRETE =
  'Vous pouvez relancer cette création gratuitement. Une seule relance offerte. Si elle n’aboutit pas, vos crédits vous seront rendus.';

export const SITE_GENERATION_REMBOURSEE =
  'Cette création n’a pas pu aboutir malgré les reprises. Vos crédits ont été rendus. Nous corrigeons la panne : vous pourrez relancer une nouvelle création plus tard, ou supprimer cet essai.';

export const SITE_RELANCE_COMPTE_A_REBOURS =
  'La relance gratuite sera disponible dans {minutes} minute(s). Merci de patienter — nous finalisons le diagnostic.';

/** Ligne de temps restant, commune aux deux écrans. */
export function attenteTempsEstime(minutes: number): string {
  if (minutes <= 1) return 'Prêt dans moins d\u2019une minute';
  return `Prêt dans environ ${minutes} minutes`;
}

/**
 * Bandeau affiché UNIQUEMENT au-delà de 5 minutes d'attente estimée.
 * Il explique l'attente sans exposer la mécanique interne.
 */
export const ATTENTE_FILE_TITRE = 'File d\u2019attente';
export const ATTENTE_FILE_MESSAGE =
  'D\u2019autres commandes sont en cours. Veuillez patienter un peu plus, votre création démarre dès qu\u2019une place se libère.';

/** Seuil (en minutes) au-delà duquel le bandeau de file est affiché. */
export const ATTENTE_SEUIL_FILE_MINUTES = 5;

// ══════════════════════════════════════════════════════════════════
// VIDÉO — incidents de production
//
// Ces textes sont lus par un commerçant, pas par un technicien. Ils
// expliquent ce qui s'est passé sans jargon, ne promettent jamais un
// résultat, et disent toujours ce que le client peut faire ensuite.
// ══════════════════════════════════════════════════════════════════

/** La vidéo n'a jamais pu être produite : les crédits sont rendus. */
export const MSG_VIDEO_REMBOURSEE =
  'Nous n’avons pas réussi à produire cette vidéo malgré plusieurs tentatives, ' +
  'en raison d’un incident technique de notre côté. Vos crédits vous ont été ' +
  'intégralement rendus. Vous pouvez lancer une nouvelle création quand vous le souhaitez.';

/** Des séquences manquent et ont été remplacées par les images de la marque. */
export const MSG_VIDEO_SEQUENCES_REMPLACEES =
  'Votre vidéo est prête. Certaines séquences n’ont pas pu être produites à cause ' +
  'd’un incident de notre côté : elles ont été remplacées par vos images. Vous pouvez ' +
  'relancer gratuitement leur création, ou garder la vidéo telle quelle.';

/** La vidéo livrée est plus courte que la durée commandée. */
export const MSG_VIDEO_PLUS_COURTE =
  'Votre vidéo est prête, mais elle est plus courte que prévu : un incident technique ' +
  'de notre côté a empêché la production de certaines séquences. Vous pouvez relancer ' +
  'gratuitement leur création, ou lancer une nouvelle vidéo si vous préférez repartir ' +
  'sur une autre idée.';

/** Affiché pendant la reprise automatique des séquences manquantes. */
export const MSG_VIDEO_REPRISE_AUTO =
  'Votre vidéo prend un peu plus de temps que prévu. Nous travaillons encore dessus — ' +
  'vous pouvez fermer cette page, nous vous préviendrons dès qu’elle est prête.';

/** Plus aucune relance gratuite : la vidéo livrée reste exploitable. */
export const MSG_VIDEO_RELANCES_EPUISEES =
  'Votre vidéo reste disponible telle quelle. Nous avons fait tout notre possible pour ' +
  'compléter les séquences manquantes. Pour un autre rendu, vous pouvez lancer une ' +
  'nouvelle création.';

// ══════════════════════════════════════════════════════════════════
// ENCAISSEMENT — transparence sur la commission
//
// Le taux est annoncé AVANT le choix du mode de paiement. Un commerçant
// qui découvrirait le prélèvement après sa première vente se sentirait
// trompé, et il aurait raison.
// ══════════════════════════════════════════════════════════════════

/** Expliqué au moment de choisir « Compte NexAI ». */
export const MSG_COMMISSION_NEXAI =
  'Avec le Compte NexAI, vos clients paient directement sur votre site et nous vous ' +
  'reversons l’argent. NexAI prélève 25 % sur chaque vente : cette part couvre les frais ' +
  'du service de paiement, la mise à disposition de l’encaissement et le reversement. ' +
  'Vous recevez donc 75 % du montant de chaque vente. ' +
  'Avec votre propre lien de paiement (Wave, Orange Money…), vos clients vous paient ' +
  'directement et NexAI ne prélève rien.';

/** Résumé court, affiché à côté du solde à reverser. */
export const MSG_COMMISSION_RAPPEL =
  'Montant net qui vous revient, après la commission NexAI de 25 % sur chaque vente.';
