import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { requireAuth } from '@/middleware/auth';
import { VideoAd } from '@/models/VideoAd';
import { enqueueVideoAd, enqueueVideoAdRelaunch } from '@/services/video-pipeline.service';
import { CREDIT_COSTS } from '@/services/credits.service';
import { uploadVideoAdProductImage } from '@/services/cloudinary.service';
import { analyzeVideoBriefCompleteness } from '@/services/video-brief-quality.service';
import { AppError } from '@/middleware/errorHandler';

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
  res.json({
    voix_off: {
      label: 'Vidéo voix off + musique (montage multi-scènes, narration IA, musique légère)',
      formats: {
        '30s': CREDIT_COSTS.VIDEO_VOIX_OFF_30S,
        '60s': CREDIT_COSTS.VIDEO_VOIX_OFF_60S,
        '120s': CREDIT_COSTS.VIDEO_VOIX_OFF_120S,
      },
      planRequis: ['createur', 'agence', 'pro_max'],
    },
    avatar_standard: {
      label: 'Vidéo Avatar Standard (présentateur IA qui parle à la caméra)',
      formats: {
        '30s': CREDIT_COSTS.VIDEO_AVATAR_STANDARD_30S,
        '60s': CREDIT_COSTS.VIDEO_AVATAR_STANDARD_60S,
      },
      planRequis: ['createur', 'agence', 'pro_max'],
    },
    avatar_scenario: {
      label: 'Mode Scénario — vidéos avatar longues (jusqu\'à 2 min) pour vos contenus IA à publier sur les réseaux : mini-films, séries, présentations.',
      formats: {
        '120s': CREDIT_COSTS.VIDEO_AVATAR_SCENARIO_120S,
      },
      // Pas de restriction de plan supplémentaire : ouvert à Créateur/Agence/Pro
      // Max comme le reste de l'outil vidéo — le prix (93 cr) fait le tri.
      planRequis: ['createur', 'agence', 'pro_max'],
    },
    note: "Outils visibles pour tous les comptes abonnés. Génération réservée aux plans Créateur, Agence et Pro Max (à crédits) — y compris le Mode Scénario.",
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
 * mode : 'voix_off' (Option 1, 30s/60s/120s) | 'avatar_standard' (30s/60s) |
 *        'avatar_scenario' (Mode Scénario, 120s uniquement — Agence/Pro Max).
 * siteId optionnel (site NexAI existant).
 * brief.siteUrl optionnel : URL du site à analyser pour personnaliser la vidéo.
 * Au moins une description dans brief est attendue côté frontend.
 */
videoAdsRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        siteId: z.string().min(1).optional(),
        mode: z.enum(['voix_off', 'avatar_standard', 'avatar_scenario']),
        format: z.enum(['30s', '60s', '120s']),
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

    // Garde-fous formats par mode (message clair avant même de débiter les crédits —
    // getVideoAdCreditCost lèverait la même erreur mais plus tard dans enqueueVideoAd).
    if (body.mode === 'avatar_standard' && body.format === '120s') {
      throw new AppError(
        "L'Avatar Mode Standard est disponible en 30s ou 60s. Utilisez le Mode Scénario pour du contenu long (120s).",
        400
      );
    }
    if (body.mode === 'avatar_scenario' && body.format !== '120s') {
      throw new AppError('Le Mode Scénario est disponible en 120 secondes (2 min) uniquement pour le moment.', 400);
    }

    const result = await enqueueVideoAd(req.auth!.userId, {
      siteId: body.siteId,
      mode: body.mode,
      format: body.format,
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
