import { estVraieImage } from '@/middleware/securite';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { requireAuth } from '@/middleware/auth';
import { getVideoTestStatus, lancerVideoTest } from '@/services/video-test.service';
import { VIDEO_TEST_INCITATION, VIDEO_TEST_TELECHARGEMENT_VERROUILLE } from '@/constants/textes-client';
import { VideoAd } from '@/models/VideoAd';
import { enqueueVideoAd, enqueueVideoAdRelaunch } from '@/services/video-pipeline.service';
import { CREDIT_COSTS, FORMATS_PAR_MODE, getVideoAdCreditCost, type VideoAdMode } from '@/services/credits.service';
import { uploadVideoAdProductImage, uploadAvatarClient, supprimerImageSite } from '@/services/cloudinary.service';
import { analyzeVideoBriefCompleteness } from '@/services/video-brief-quality.service';
import { AppError } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { AVATAR_OPTIONS, normaliserChoixAvatar, verifierPhotoAvatar } from '@/services/avatar-choix.service';
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
      if (!ALLOWED_PRODUCT_IMAGE_MIME.has(file.mimetype) || !estVraieImage(file.buffer, file.mimetype)) {
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
  // Grille par offre : `formats[durée] = crédits`. Le frontend lit cette forme.
  // Logique commerciale : jusqu'à 45 s, Express et Présentateur ; à partir de
  // 60 s, uniquement le cinéma (Agence et Pro Max).
  const grille = (mode: VideoAdMode) =>
    Object.fromEntries(FORMATS_PAR_MODE[mode].map((f) => [f, getVideoAdCreditCost(mode, f)]));
  res.json({
    express: { label: 'Pub Express', formats: grille('express'), planRequis: ['createur', 'agence', 'pro_max'] },
    avatar_pub: { label: 'Pub Présentateur IA', formats: grille('avatar_pub'), planRequis: ['createur', 'agence', 'pro_max'] },
    voix_off: { label: 'Pub Cinéma IA', formats: grille('voix_off'), planRequis: ['agence', 'pro_max'] },
    mini_film: { label: 'Mini-film IA', formats: grille('mini_film'), planRequis: ['agence', 'pro_max'] },
    note: 'Toutes les offres sont visibles dès Créateur+. Pub Cinéma IA et Mini-film IA sont réservés à Agence et Pro Max.',
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
    const mode = String(req.query.mode ?? 'express');
    if (!['express', 'voix_off', 'avatar_pub', 'mini_film'].includes(mode)) {
      throw new AppError('Mode vidéo inconnu.', 400);
    }
    res.json({
      questions: questionnairePourMode(
        mode as 'express' | 'voix_off' | 'avatar_pub' | 'mini_film',
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
    const user = await User.findById(req.auth!.userId).select('avatarPrefere avatarPhoto');
    const photo = user?.avatarPhoto?.url ? { url: user.avatarPhoto.url, voix: user.avatarPhoto.voix } : null;
    res.json({
      options: AVATAR_OPTIONS,
      choixActuel: normaliserChoixAvatar(user?.avatarPrefere),
      // Vrai si le client n'a encore jamais choisi : le frontend peut alors
      // mettre l'étape en avant plutôt que de la laisser passer inaperçue.
      premierChoix: !user?.avatarPrefere?.genre && !photo,
      source: photo && user?.avatarPrefere?.source === 'photo' ? 'photo' : 'ia',
      photo,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /avatar/photo — « Mon propre visage ».
 *
 * Le client envoie une photo de lui ; elle est vérifiée automatiquement
 * (une seule personne, visage net de face, adulte, pas une célébrité), puis
 * devient son présentateur. Le consentement est obligatoire et daté. La
 * photo précédente éventuelle est supprimée.
 */
const PLANS_PRESENTATEUR = new Set(['createur', 'agence', 'pro_max']);
videoAdsRouter.post(
  '/avatar/photo',
  requireAuth,
  productImageUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.auth!.userId).select('plan role avatarPhoto avatarPrefere');
      if (!user) throw new AppError('Compte introuvable.', 404);
      if (user.role !== 'admin' && !PLANS_PRESENTATEUR.has(String(user.plan))) {
        throw new AppError('« Mon propre visage » est disponible à partir de l’abonnement Créateur+.', 403);
      }
      const { consentement, voix } = z
        .object({ consentement: z.literal('oui'), voix: z.enum(['homme', 'femme']) })
        .parse(req.body ?? {});
      void consentement;
      const file = req.file;
      if (!file) throw new AppError('Aucune photo reçue.', 400);
      if (!ALLOWED_PRODUCT_IMAGE_MIME.has(file.mimetype) || !estVraieImage(file.buffer, file.mimetype)) {
        throw new AppError('Format non supporté (PNG, JPEG ou WEBP uniquement).', 400);
      }
      const envoi = await uploadAvatarClient(file.buffer);
      const controle = await verifierPhotoAvatar(envoi.url);
      if (!controle.ok) {
        await supprimerImageSite(envoi.publicId).catch(() => undefined);
        throw new AppError(controle.raison ?? 'Cette photo ne convient pas.', 422);
      }
      const ancienne = user.avatarPhoto?.publicId;
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            avatarPhoto: { url: envoi.url, publicId: envoi.publicId, voix, consentementLe: new Date() },
            'avatarPrefere.source': 'photo',
            'avatarPrefere.genre': voix,
          },
        }
      );
      if (ancienne && ancienne !== envoi.publicId) await supprimerImageSite(ancienne).catch(() => undefined);
      res.status(201).json({
        message: 'Votre photo est validée. Vous présenterez vous-même vos prochaines vidéos avec présentateur.',
        photo: { url: envoi.url, voix },
        source: 'photo',
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(new AppError('Cochez la case d’accord et choisissez la voix (homme ou femme).', 400));
      }
      next(err);
    }
  }
);

/** PUT /avatar/source — choisir entre sa photo (déjà validée) et le présentateur IA. */
videoAdsRouter.put('/avatar/source', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source } = z.object({ source: z.enum(['ia', 'photo']) }).parse(req.body ?? {});
    const user = await User.findById(req.auth!.userId).select('avatarPhoto');
    if (source === 'photo' && !user?.avatarPhoto?.url) throw new AppError('Envoyez d’abord votre photo.', 400);
    await User.updateOne({ _id: req.auth!.userId }, { $set: { 'avatarPrefere.source': source } });
    res.json({ source });
  } catch (err) {
    next(err);
  }
});

/** DELETE /avatar/photo — retire la photo (supprimée de nos serveurs) et revient au présentateur IA. */
videoAdsRouter.delete('/avatar/photo', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('avatarPhoto');
    const publicId = user?.avatarPhoto?.publicId;
    await User.updateOne({ _id: req.auth!.userId }, { $unset: { avatarPhoto: 1 }, $set: { 'avatarPrefere.source': 'ia' } });
    if (publicId) await supprimerImageSite(publicId).catch(() => undefined);
    res.json({ message: 'Votre photo a été supprimée. Vos vidéos utiliseront le présentateur choisi ci-dessous.', source: 'ia' });
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
    // Enregistrer un présentateur IA le remet en service (la photo éventuelle
    // reste gardée pour revenir dessus, tant que le client ne la supprime pas).
    await User.updateOne({ _id: req.auth!.userId }, { $set: { avatarPrefere: { ...choix, source: 'ia' } } });
    res.json({
      message: 'Votre présentateur est enregistré. Il apparaîtra dans toutes vos prochaines vidéos avec avatar.',
      choixActuel: choix,
      source: 'ia',
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
 * mode / durées : voir FORMATS_PAR_MODE (credits.service.ts).
 * quality : conservé pour compatibilité, sans effet sur le prix.
 * siteId optionnel (site NexAI existant).
 * brief.siteUrl optionnel : URL du site à analyser pour personnaliser la vidéo.
 * Au moins une description dans brief est attendue côté frontend.
 */
videoAdsRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        siteId: z.string().min(1).optional(),
        mode: z.enum(['express', 'voix_off', 'avatar_pub', 'mini_film']),
        format: z.enum(['15s', '30s', '45s', '60s', '120s']),
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

    // Garde-fou durée : message clair avant tout débit.
    if (!FORMATS_PAR_MODE[body.mode].includes(body.format)) {
      throw new AppError('Cette durée n’est pas proposée pour cette vidéo. Choisissez une des durées affichées.', 400);
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
 * mineur (badge "résultat perfectible"). Débite le prix de la vidéo (plein
 * tarif), crée une nouvelle génération complète, laisse la vidéo
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
    // Les vidéos de l'essai gratuit se regardent en streaming uniquement : leur
    // URL ne doit jamais sortir, sinon le client pourrait les télécharger sans
    // s'abonner (même règle que GET /:id).
    const videos = list.map((v) => {
      const objet = v.toObject() as unknown as Record<string, unknown>;
      // Détail technique d'un échec : réservé à l'administration.
      if (req.auth!.role !== 'admin') delete objet.errorMessage;
      if ((v.brief as Record<string, unknown> | undefined)?.isTrialTest === true) {
        delete objet.outputUrl;
        delete objet.finalVideoUrl;
        objet.telechargementAutorise = false;
      }
      return objet;
    });
    res.json({ videos });
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
 * POST /test — ancien test vidéo de l'essai (retiré) : répond toujours par
 * un refus explicite, voir video-test.service.ts.
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
