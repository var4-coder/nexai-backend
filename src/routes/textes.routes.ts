import { Router, Request, Response } from 'express';
import * as T from '@/constants/textes-client';
import { PAYS, LANGUES_SUPPORTEES, LANGUE_LABELS } from '@/constants/pays';

export const textesRouter = Router();

/**
 * GET /textes — textes client figés, servis au frontend.
 *
 * Source UNIQUE volontaire (Architecture v6) : le frontend ne duplique
 * jamais ces libellés en dur. Une correction de formulation s'applique donc
 * immédiatement partout, sans redéploiement du frontend et sans risque de
 * divergence entre les deux côtés.
 *
 * Route publique (aucun secret, uniquement des textes d'interface) et
 * cacheable — ces valeurs ne changent qu'à un déploiement backend.
 */
textesRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    apercu: {
      casNormal: T.APERCU_CAS_NORMAL,
      casCasse: T.APERCU_CAS_CASSE,
      boutonAmeliorer: T.APERCU_BOUTON_AMELIORER,
      boutonMettreEnLigne: T.APERCU_BOUTON_METTRE_EN_LIGNE,
    },
    verrous: {
      qualitePremium: T.VERROU_QUALITE_PREMIUM,
      miseEnLigne: T.VERROU_MISE_EN_LIGNE,
      videoIa: T.VERROU_VIDEO_IA,
      achatCredits: T.VERROU_ACHAT_CREDITS,
      espaceAgence: T.VERROU_ESPACE_AGENCE,
      miniFilm: T.VERROU_MINI_FILM,
    },
    videoTest: {
      incitation: T.VIDEO_TEST_INCITATION,
      telechargementVerrouille: T.VIDEO_TEST_TELECHARGEMENT_VERROUILLE,
    },
    bandeaux: {
      bienvenueEssai: T.BANDEAU_BIENVENUE_ESSAI,
    },
    retrait: {
      compteNexai: T.RETRAIT_COMPTE_NEXAI,
      lienPersonnel: T.RETRAIT_LIEN_PERSONNEL,
    },
    hub: {
      intro: T.HUB_INTRO,
      trouverBusiness: T.HUB_TROUVER_BUSINESS,
      creerLogo: T.HUB_CREER_LOGO,
      creerSite: T.HUB_CREER_SITE,
    },
    attente: {
      videoTitre: T.ATTENTE_VIDEO_TITRE,
      videoSousTitre: T.ATTENTE_VIDEO_SOUS_TITRE,
      siteTitre: T.ATTENTE_SITE_TITRE,
      siteSousTitre: T.ATTENTE_SITE_SOUS_TITRE,
      fileTitre: T.ATTENTE_FILE_TITRE,
      fileMessage: T.ATTENTE_FILE_MESSAGE,
      seuilFileMinutes: T.ATTENTE_SEUIL_FILE_MINUTES,
    },
  });
});

/**
 * GET /textes/pays — catalogue des pays servis, avec indicatif téléphonique et
 * langue d'interface par défaut.
 *
 * Route PUBLIQUE : le formulaire d'inscription en a besoin avant qu'un compte
 * n'existe. Même principe de source unique que /textes — le frontend ne
 * duplique jamais cette liste, ajouter un pays côté backend le rend
 * immédiatement disponible sur tous les écrans (inscription, abonnement,
 * achat de crédits, retrait).
 */
textesRouter.get('/pays', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({
    pays: PAYS,
    langues: LANGUES_SUPPORTEES.map((code) => ({
      code,
      label: LANGUE_LABELS[code],
    })),
  });
});
