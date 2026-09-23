import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { requireAuth } from '@/middleware/auth';
import { getVideoTestStatus, lancerVideoTest } from '@/services/video-test.service';
import { VIDEO_TEST_INCITATION, VIDEO_TEST_TELECHARGEMENT_VERROUILLE } from '@/constants/textes-client';
import { VideoAd } from '@/models/VideoAd';
import { enqueueVideoAd, enqueueVideoAdRelaunch } from '@/services/video-pipeline.service';
import { CREDIT_COSTS } from '@/services/credits.service';
import { uploadVideoAdProductImage } from '@/services/cloudinary.service';
import { analyzeVideoBriefCompleteness } from '@/services/video-brief-quality.service';
import { AppError } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { AVATAR_OPTIONS, normaliserChoixAvatar } from '@/services/avatar-choix.service';
import { questionnairePourMode, relancerSiVague } from '@/services/brief-questionnaire.service';
import { estimerAttente } from '@/services/attente.service';

export const videoAdsRouter = Router();

// Upload de photos produit (client) à utiliser comme référence image-to-image
// dans la vidéo — même limite que les pièces jointes du chat (15 Mo, images
// uniquement, jamais de vidéo/pdf ici).
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const ALLOWED_PRODUCT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * POST /photos-produit — upload d'une photo produit à ajouter au brief avant
 * de lancer la génération. Renvoie l'URL Cloudinary à repasser dans
 * brief.clientProductImageUrls lors du POST /.
 * Appelable plusieurs fois (jusqu'à 6 images retenues côté pipeline, le
 * surplus éventuel est simplement ignoré sans erreur).
 */
videoAdsRouter.post(
  '/photos-produit',
  requireAuth,
  productImageUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) throw new AppError('Aucune image reçue.', 400);
      if (!ALLOWED_PRODUCT_IMAGE_MIME.has(file.mimetype)) {
        throw new AppError('Format non supporté (PNG, JPEG ou WEBP uniquement).', 400);
      }
      const result = await uploadVideoAdProductImage(file.buffer, file.originalname);
      res.status(201).json({ url: result.url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tarifs — grille publique des prix (crédits NexAI), les 3 produits vidéo IA.
 */
videoAdsRouter.get('/tarifs', (_req: Request, res: Response) => {
  // Grille PLATE par durée : `formats[durée] = crédits`. Aucun choix de
  // qualité côté client — le moteur découle de la durée (voir
  // getVideoEngineForFormat). Le frontend lit exactement cette forme.
  res.json({
    voix_off: {
      label: 'Vidéo pub voix off',
      description:
        'Une publicité visuelle avec voix off et musique de fond, pour présenter votre activité ou vos produits.',
      formats: {
        '20s': CREDIT_COSTS.VOIX_OFF_20S,
        '30s': CREDIT_COSTS.VOIX_OFF_30S,
        '60s': CREDIT_COSTS.VOIX_OFF_60S,
      },
      planRequis: ['createur', 'agence', 'pro_max'],
    },
    avatar_pub: {
      label: 'Avatar pub',
      description: 'Un présentateur IA qui parle face caméra pour promouvoir votre activité.',
      formats: {
        '20s': CREDIT_COSTS.AVATAR_PUB_20S,
        '30s': CREDIT_COSTS.AVATAR_PUB_30S,
        '60s': CREDIT_COSTS.AVATAR_PUB_60S,
      },
      planRequis: ['createur', 'agence', 'pro_max'],
    },
    mini_film: {
      label: 'Mini-film',
      description:
        "Deux minutes en qualité cinéma, plusieurs scènes qui racontent une histoire. Pour votre entreprise, une vraie publicité de présentation. Pour les créateurs de contenu, des histoires et des séries prêtes à publier sur TikTok, Instagram, Facebook ou YouTube.",
      formats: { '120s': CREDIT_COSTS.MINI_FILM_120S },
      // Réservé à Pro Max. Visible par tous, génération verrouillée ailleurs.
      planRequis: ['pro_max'],
    },
    note:
      "Outils visibles par tous. Génération réservée aux abonnements Créateur+, Agence et Pro Max ; le mini-film est réservé à Pro Max.",
  });
});

/**
 * POST /analyser-brief — scan qualité AVANT lancement (aucun débit de
 * crédits). Utilisé par le frontend pour guider le client en temps réel
 * quand il n'a pas fourni d'URL de site (voir video-brief-quality.service.ts
 * pour la logique complète et la justification du "pourquoi seulement dans
 * ce cas"). Le même contrôle est ré-appliqué côté serveur dans
 * enqueueVideoAd — cette route ne remplace pas ce garde-fou, elle sert
 * uniquement à donner un retour immédiat avant que le client ne clique sur
 * "Générer".
 */
/**
 * GET /avatar — options de présentateur et choix actuel du client.
 *
 * Le frontend ne code aucune option en dur : elles viennent d'ici, avec
 * leurs libellés. Ne concerne que les modes avec avatar.
 */
/**
 * GET /questionnaire — questions à poser au client pour ce mode.
 *
 * Le frontend n'écrit aucune question en dur : elles viennent d'ici, avec
 * leurs aides et leurs exemples. Un client guidé décrit mieux, et le
 * scénariste produit une meilleure vidéo.
 */
videoAdsRouter.get('/questionnaire', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mode = String(req.query.mode ?? 'voix_off');
    if (!['voix_off', 'avatar_pub', 'mini_film'].includes(mode)) {
      throw new AppError('Mode vidéo inconnu.', 400);
    }
    res.json({
      questions: questionnairePourMode(
        mode as 'voix_off' | 'avatar_pub' | 'mini_film',
        req.query.composition ? String(req.query.composition) : undefined
      ),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /questionnaire/relancer — vérifie une réponse et propose une
 * reformulation si elle est trop vague. Ne bloque JAMAIS : le client garde
 * la main, la relance est une aide.
 */
videoAdsRouter.post('/questionnaire/relancer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cle, reponse } = z
      .object({ cle: z.string().min(1).max(40), reponse: z.string().max(2000) })
      .parse(req.body ?? {});
    res.json({ relance: relancerSiVague(cle, reponse) });
  } catch (err) {
    next(err);
  }
});

videoAdsRouter.get('/avatar', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('avatarPrefere');
    res.json({
      options: AVATAR_OPTIONS,
      choixActuel: normaliserChoixAvatar(user?.avatarPrefere),
      // Vrai si le client n'a encore jamais choisi : le frontend peut alors
      // mettre l'étape en avant plutôt que de la laisser passer inaperçue.
      premierChoix: !user?.avatarPrefere?.genre,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /avatar — enregistre le présentateur choisi.
 *
 * Mémorisé sur le compte : toutes les prochaines vidéos avec avatar
 * l'utiliseront, jusqu'à ce que le client en change.
 */
videoAdsRouter.patch('/avatar', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const choix = normaliserChoixAvatar(req.body ?? {});
    await User.updateOne({ _id: req.auth!.userId }, { $set: { avatarPrefere: choix } });
    res.json({
      message: 'Votre présentateur est enregistré. Il apparaîtra dans toutes vos prochaines vidéos avec avatar.',
      choixActuel: choix,
    });
  } catch (err) {
    next(err);
  }
});

videoAdsRouter.post('/analyser-brief', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        description: z.string().optional(),
        brandName: z.string().optional(),
        ctaText: z.string().optional(),
      })
      .parse(req.body ?? {});
    const analysis = await analyzeVideoBriefCompleteness(body);
    res.json(analysis);
  } catch (err) {
    next(err);
  }
});

/**
 * POST / — lance une génération vidéo.
 * mode : 'voix_off' (30s/60s/120s) | 'avatar_pub' (30s/60s/120s) |
 *        'mini_film' (120s uniquement — Pro Max exclusivement).
 * quality : 'standard' | 'premium' (Premium = ×2 crédits, tous modes).
 * siteId optionnel (site NexAI existant).
 * brief.siteUrl optionnel : URL du site à analyser pour personnaliser la vidéo.
 * Au moins une description dans brief est attendue côté frontend.
 */
videoAdsRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        siteId: z.string().min(1).optional(),
        mode: z.enum(['voix_off', 'avatar_pub', 'mini_film']),
        format: z.enum(['20s', '30s', '60s', '120s']),
        quality: z.enum(['standard', 'premium']).default('standard'),
        aspectRatio: z.enum(['16:9', '9:16']).default('16:9'),
        brief: z
          .object({
            description: z.string().min(10).optional(),
            brandName: z.string().optional(),
            ctaText: z.string().optional(),
            siteUrl: z.string().url().or(z.string().min(4)).optional(),
            style: z.string().optional(),
            durationHint: z.string().optional(),
            /** URLs Cloudinary renvoyées par POST /photos-produit — photos produit
             * ajoutées par le client, utilisées en priorité comme référence
             * image-to-image (voir product-image-sourcing.service.ts). */
            clientProductImageUrls: z.array(z.string().url()).max(6).optional(),
            /**
             * Mini-film uniquement : décide du style des plans.
             *  · 'histoire'     — une histoire filmée avec des acteurs
             *  · 'decouverte'   — scènes cinématiques sans acteur
             *  · 'presentateur' — un présentateur face caméra
             */
            composition: z.enum(['histoire', 'decouverte', 'presentateur']).optional(),
            /**
             * Histoire racontée par le client. Laissée vide, le scénariste en
             * écrit une, adaptée au produit et au public visé.
             */
            scenario: z.string().max(2000).optional(),
            /** Présentateur choisi, pour les modes avec avatar. */
            avatar: z
              .object({
                genre: z.string().optional(),
                carnation: z.string().optional(),
                age: z.string().optional(),
                style: z.string().optional(),
              })
              .optional(),
          })
          .passthrough()
          .default({}),
      })
      .parse(req.body);

    if (!body.brief.description && !body.brief.siteUrl && !body.siteId) {
      throw new AppError(
        'Fournissez au minimum une description de la vidéo ou une URL de site à personnaliser.',
        400
      );
    }

    // Garde-fou format (message clair avant même de débiter les crédits —
    // getVideoAdCreditCost lèverait la même erreur mais plus tard dans enqueueVideoAd).
    if (body.mode === 'mini_film' && body.format !== '120s') {
      throw new AppError('Le mode Mini-film/série est disponible en 120 secondes uniquement.', 400);
    }

    const result = await enqueueVideoAd(req.auth!.userId, {
      siteId: body.siteId,
      mode: body.mode,
      format: body.format,
      quality: body.quality,
      aspectRatio: body.aspectRatio,
      brief: body.brief as Record<string, unknown>,
    });

    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/relancer — relance corrective d'une vidéo livrée avec un défaut
 * mineur (badge "résultat perfectible"). Débite le prix réduit (50% pour la
 * 1ère relance), crée une nouvelle génération complète, laisse la vidéo
 * d'origine intacte. Renvoie 400 si la vidéo n'est pas éligible (pas de
 * défaut détecté, ou relance déjà utilisée).
 */
videoAdsRouter.post('/:id/relancer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await enqueueVideoAdRelaunch(req.auth!.userId, req.params.id);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id — statut d'une génération vidéo en cours ou terminée.
 */
videoAdsRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const videoAd = await VideoAd.findById(req.params.id);
    if (!videoAd) throw new AppError('Vidéo introuvable', 404);
    if (String(videoAd.userId) !== String(req.auth!.userId)) throw new AppError('Accès refusé', 403);

    // Vidéo de test de l'essai gratuit : lecture en streaming uniquement.
    // L'URL brute n'est JAMAIS renvoyée, sinon le client pourrait
    // télécharger la vidéo et l'utiliser sans jamais s'abonner — ce qui
    // viderait l'intérêt de l'abonnement (Architecture v6, section 7).
    const brief = videoAd.brief as Record<string, unknown> | undefined;
    if (brief?.isTrialTest === true) {
      const objet = videoAd.toObject() as unknown as Record<string, unknown>;
      delete objet.outputUrl;
      delete objet.finalVideoUrl;
      res.json({
        ...objet,
        // Le frontend lit la vidéo via cette route de streaming, qui ne
        // délivre jamais de lien permanent.
        streamUrl: videoAd.status === 'completed' ? `/api/video-ads/${videoAd._id}/stream` : null,
        telechargementAutorise: false,
        messageTelechargement: VIDEO_TEST_TELECHARGEMENT_VERROUILLE,
        messageIncitation: VIDEO_TEST_INCITATION,
      });
      return;
    }

    // Estimation d'attente : permet au frontend d'afficher un compte à rebours
    // réel plutôt qu'un écran qui tourne indéfiniment.
    if (videoAd.status === 'queued' || videoAd.status === 'generating') {
      const ecoule = Math.floor(
        (Date.now() - new Date(videoAd.createdAt).getTime()) / 1000
      );
      const attente = await estimerAttente({
        kind: 'video',
        format: videoAd.format,
        enCours: videoAd.status === 'generating',
        demarreeIlYaSecondes: ecoule,
      });
      res.json({ ...videoAd.toObject(), attente });
      return;
    }

    res.json(videoAd);
  } catch (err) {
    next(err);
  }
});

/**
 * GET / — liste des vidéos de l'utilisateur
 */
videoAdsRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await VideoAd.find({ userId: req.auth!.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-scenes.prompt');
    res.json({ videos: list });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════
// « TESTER VIDÉO IA » — essai gratuit (Architecture v6, section 7)
//
// Volontairement sur la MÊME page que Vidéo IA côté client : en essai, le
// bouton « Générer » est verrouillé et un bouton « Tester » apparaît à côté.
// Ce sont donc deux endpoints distincts sur la même interface, pas une
// page séparée.
// ══════════════════════════════════════════════════════════════════

/**
 * GET /test/status — état du bouton « Tester » (visible ? disponible ?
 * déjà utilisé ?). Appelé au chargement de la page Vidéo IA.
 */
videoAdsRouter.get('/test/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getVideoTestStatus(req.auth!.userId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /test — lance la génération du test (8s, avatar générique, 10cr,
 * une seule fois, sans téléchargement possible).
 */
videoAdsRouter.post('/test', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        brandName: z.string().max(120).optional(),
        activite: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});

    const result = await lancerVideoTest(req.auth!.userId, body);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id/stream — lecture en streaming de la vidéo de test (essai gratuit).
 *
 * Le backend relaie le flux au lieu de renvoyer l'URL du fournisseur :
 * le client peut regarder la vidéo autant qu'il veut, mais n'obtient
 * jamais de lien permanent réutilisable ailleurs. Même principe que le
 * streaming signé de l'Academy.
 */
videoAdsRouter.get('/:id/stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const videoAd = await VideoAd.findById(req.params.id);
    if (!videoAd) throw new AppError('Vidéo introuvable', 404);
    if (String(videoAd.userId) !== String(req.auth!.userId)) throw new AppError('Accès refusé', 403);
    if (videoAd.status !== 'completed') {
      throw new AppError("Cette vidéo n'est pas encore prête.", 409);
    }

    const source = (videoAd as unknown as { outputUrl?: string; finalVideoUrl?: string });
    const url = source.outputUrl ?? source.finalVideoUrl;
    if (!url) throw new AppError('Fichier vidéo indisponible.', 404);

    const upstream = await fetch(url, {
      // Relaie la requête de plage : indispensable pour que le lecteur
      // puisse se déplacer dans la vidéo sans tout retélécharger.
      headers: req.headers.range ? { Range: String(req.headers.range) } : {},
    });
    if (!upstream.ok || !upstream.body) {
      throw new AppError('Lecture de la vidéo impossible pour le moment.', 502);
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'video/mp4');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const range = upstream.headers.get('content-range');
    if (range) res.setHeader('Content-Range', range);
    res.setHeader('Accept-Ranges', 'bytes');
    // Empêche la mise en cache d'un fichier qui ne doit pas être conservé
    // hors de la plateforme, et décourage le téléchargement direct.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');

    const { Readable } = await import('stream');
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } catch (err) {
    next(err);
  }
});
