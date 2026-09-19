import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth, requireRole } from '@/middleware/auth';
import { User, UserPlan } from '@/models/User';
import { Site } from '@/models/Site';
import { Job } from '@/models/Job';
import { PaiementChariow } from '@/models/PaiementChariow';
import { VideoAd } from '@/models/VideoAd';
import { estimateVideoAdRealCostUsd } from '@/services/credits.service';
import { AcademyContent } from '@/models/AcademyContent';
import { BoutiqueProduct } from '@/models/BoutiqueProduct';
import { markPaiementPaye } from '@/services/chariow.service';
import { creditCredits, PLAN_CREDITS } from '@/services/credits.service';
import {
  uploadAcademyPdf,
  uploadAcademyVideo,
  uploadBoutiqueProduct,
  deleteAcademyResource,
  deleteBoutiqueResource,
} from '@/services/cloudinary.service';
import { buildAutoDraft, regenerateTitleAndDescription } from '@/services/academy-boutique-automation.service';
import { env } from '@/config/env';
import { genererAvis } from '@/services/avis-generation.service';
import { getStatutSecurite, demanderChangementEmail, confirmerChangementEmail } from '@/services/admin-security.service';
import { Avis } from '@/models/Avis';
import { PlatformAlert } from '@/models/PlatformAlert';
import { BoutiquePack } from '@/models/BoutiquePack';
import { AcademyPack } from '@/models/AcademyPack';
import {
  estArchiveZip,
  extraireArchive,
  typeDepuisNom,
  titreDepuisNomFichier,
  type PackFile,
} from '@/services/pack-upload.service';
import { buildRapportQualite } from '@/services/quality-report.service';
import { AlerteQualite } from '@/models/AlerteQualite';
import { SystemLog } from '@/models/SystemLog';
import { logEvent } from '@/services/logs.service';
import { pipelineQueue } from '@/jobs/queue';
import {
  lancerDiagnosticPrompts,
  appliquerCandidat,
  refuserCandidat,
  restaurerVersion,
  getHistoriquePrompts,
  getCandidatsEnAttente,
} from '@/services/prompt-diagnostic.service';
import type { PromptCible } from '@/models/PromptVersion';
import { listAiTeamConfig, setModelForRole } from '@/services/ai-role-registry';
import type { AiRole } from '@/models/AiRoleConfig';
import {
  listerClientsAReverser,
  getSoldeReversement,
  getHistoriqueReversement,
  marquerCommeReverse,
} from '@/services/reversement.service';
import { AppError } from '@/middleware/errorHandler';
import {
  listTicketsForAdmin,
  getTicketForAdmin,
  adminReply,
  closeTicket,
} from '@/services/support.service';

export const adminRouter = Router();

adminRouter.use(requireAuth);

// Upload en mémoire (pas de fichier temp sur disque) — limite 300 Mo pour couvrir les vidéos.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

// ─── Users ───────────────────────────────────────────────

adminRouter.get('/users', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await User.find()
      .select('email role plan trialEndsAt creditsBalance domainsUsed createdAt googleId')
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch(
  '/users/:id/plan',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          plan: z.enum(['trial', 'starter', 'createur', 'agence', 'pro_max']),
          grantPlanCredits: z.boolean().optional().default(false),
        })
        .parse(req.body);

      const user = await User.findById(req.params.id);
      if (!user) throw new AppError('Utilisateur introuvable', 404);

      user.plan = body.plan as UserPlan;
      if (body.plan !== 'trial') {
        user.trialEndsAt = undefined;
      }
      await user.save();

      if (body.grantPlanCredits) {
        const amount = PLAN_CREDITS[body.plan] ?? 0;
        if (amount > 0) {
          await creditCredits(user._id, amount, 'ajustement_admin', {
            note: `plan:${body.plan}`,
          });
        }
      }

      const refreshed = await User.findById(user._id).select(
        'email role plan trialEndsAt creditsBalance domainsUsed'
      );
      res.json({ user: refreshed });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/users/:id/credits',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          amount: z.number().int().refine((n) => n !== 0, 'Montant non nul requis'),
          note: z.string().max(200).optional(),
        })
        .parse(req.body);

      const user = await User.findById(req.params.id);
      if (!user) throw new AppError('Utilisateur introuvable', 404);

      if (body.amount > 0) {
        await creditCredits(user._id, body.amount, 'ajustement_admin', {
          note: body.note || 'ajustement admin',
        });
      } else {
        // Débit admin : bypass trial lock
        const abs = Math.abs(body.amount);
        if (user.creditsBalance < abs) {
          throw new AppError('Solde insuffisant pour ce débit admin', 400);
        }
        user.creditsBalance -= abs;
        await user.save();
        const { CreditTransaction } = await import('@/models/CreditTransaction');
        await CreditTransaction.create({
          userId: user._id,
          type: 'ajustement_admin',
          amount: -abs,
          balanceAfter: user.creditsBalance,
          note: body.note || 'ajustement admin',
        });
      }

      const refreshed = await User.findById(user._id).select('email plan creditsBalance');
      res.json({ user: refreshed });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Vidéo IA — stats échecs/remboursements ────────────────

/**
 * GET /admin/video-ads/stats — taux d'échec réel et coût perdu estimé sur les
 * vidéos IA, pour suivre si la marge (30-40% visée) tient compte tenu des
 * échecs remboursés. `days` (optionnel, défaut 30) limite la fenêtre.
 *
 * - tauxEchec = vidéos remboursées / total généré (hors en cours)
 * - creditsPerdus = somme des creditsCharged des vidéos remboursées (jamais
 *   récupérés, puisque remboursés intégralement au client)
 * - coutReelPerduUsd = estimation du coût fournisseur déjà engagé et non
 *   récupérable sur ces échecs (voir VIDEO_AD_REAL_COST_USD) — approximatif,
 *   ne tient pas compte du taux de retry déjà consommé avant l'échec final.
 * - livraisonsDegradees = vidéos livrées avec un badge "résultat perfectible"
 *   (défaut mineur non bloquant) et taux d'utilisation de la relance corrective.
 */
adminRouter.get(
  '/video-ads/stats',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const videos = await VideoAd.find({ createdAt: { $gte: since } }).select(
        'mode format quality status creditsCharged qcReport relaunchOffer isRelaunchOf createdAt'
      );

      const finished = videos.filter((v) => v.status === 'completed' || v.status === 'refunded' || v.status === 'failed');
      const refunded = videos.filter((v) => v.status === 'refunded');
      const completed = videos.filter((v) => v.status === 'completed');
      const degraded = completed.filter((v) => v.qcReport?.degraded);
      const relaunchesUsed = completed.filter((v) => v.relaunchOffer?.used);

      const creditsPerdus = refunded.reduce((sum, v) => sum + (v.creditsCharged || 0), 0);
      const coutReelPerduUsd = refunded.reduce((sum, v) => {
        const cout = estimateVideoAdRealCostUsd(v.mode, v.format, v.quality);
        return sum + (cout ?? 0);
      }, 0);

      const parMode: Record<string, { total: number; rembourses: number; degrades: number }> = {};
      for (const v of finished) {
        parMode[v.mode] ??= { total: 0, rembourses: 0, degrades: 0 };
        parMode[v.mode].total += 1;
        if (v.status === 'refunded') parMode[v.mode].rembourses += 1;
        if (v.qcReport?.degraded) parMode[v.mode].degrades += 1;
      }

      res.json({
        periode: { jours: days, depuis: since },
        totalVideosGenerees: finished.length,
        totalRembourses: refunded.length,
        tauxEchec: finished.length > 0 ? Number((refunded.length / finished.length).toFixed(4)) : 0,
        creditsPerdus,
        coutReelPerduUsd: Number(coutReelPerduUsd.toFixed(2)),
        livraisonsDegradees: degraded.length,
        tauxDegradation: completed.length > 0 ? Number((degraded.length / completed.length).toFixed(4)) : 0,
        relancesCorrectivesUtilisees: relaunchesUsed.length,
        tauxUtilisationRelance: degraded.length > 0 ? Number((relaunchesUsed.length / degraded.length).toFixed(4)) : 0,
        parMode,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Paiements ───────────────────────────────────────────

adminRouter.get(
  '/paiements',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const statut = req.query.statut as string | undefined;
      const filter = statut ? { statut } : {};
      const paiements = await PaiementChariow.find(filter)
        .populate('siteId', 'domainName niche userId')
        .sort({ webhookReceivedAt: -1 })
        .limit(200);
      res.json({ paiements });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/paiements/:id/paye',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paiement = await markPaiementPaye(req.params.id);
      res.json({ paiement });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Support ─────────────────────────────────────────────

adminRouter.get(
  '/support/file',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sites = await Site.find({ status: 'pending_support' })
        .populate('userId', 'email')
        .sort({ updatedAt: -1 })
        .limit(100);
      res.json({ sites });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get(
  '/sites/alertes',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sites = await Site.find({
        status: { $in: ['failed', 'pending_support', 'generating'] },
      })
        .populate('userId', 'email')
        .sort({ updatedAt: -1 })
        .limit(50);

      const siteIds = sites.map((s) => s._id);
      const jobs = await Job.find({
        siteId: { $in: siteIds },
        status: { $in: ['failed', 'active', 'queued'] },
      })
        .sort({ updatedAt: -1 })
        .lean();

      const errorBySite = new Map<string, string>();
      for (const j of jobs) {
        const key = String(j.siteId);
        if (!errorBySite.has(key) && j.error) errorBySite.set(key, j.error);
      }

      const enriched = sites.map((s) => {
        const obj = s.toObject({ virtuals: true }) as Record<string, unknown>;
        return {
          ...obj,
          id: String(s._id),
          lastError:
            (s as { lastError?: string }).lastError ||
            errorBySite.get(String(s._id)) ||
            null,
        };
      });

      res.json({ sites: enriched });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Académie CRUD ───────────────────────────────────────

adminRouter.get(
  '/academy',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const contents = await AcademyContent.find().select('+sourceUrl').sort({ createdAt: -1 });
      res.json({ contents });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Upload direct d'un fichier PDF ou vidéo depuis l'admin (multipart/form-data,
 * champ "file"). Renvoie un cloudinaryPublicId à réutiliser comme sourceUrl
 * lors de la création/mise à jour du contenu, sans passer par le dashboard
 * Cloudinary séparément.
 *
 * Champ attendu : type = 'pdf' | 'video'
 */
adminRouter.post(
  '/academy/upload',
  requireRole('admin'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = z.enum(['pdf', 'video']).parse(req.body.type);
      if (!req.file) throw new AppError('Fichier manquant (champ "file")', 400);

      if (type === 'pdf' && req.file.mimetype !== 'application/pdf') {
        throw new AppError('Le fichier doit être un PDF', 400);
      }
      if (type === 'video' && !req.file.mimetype.startsWith('video/')) {
        throw new AppError('Le fichier doit être une vidéo', 400);
      }

      const publicId =
        type === 'pdf'
          ? await uploadAcademyPdf(req.file.buffer, req.file.originalname)
          : await uploadAcademyVideo(req.file.buffer, req.file.originalname);

      res.status(201).json({ cloudinaryPublicId: publicId, hosting: 'cloudinary', type });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Upload AUTOMATISÉ (décision produit) : l'admin fournit uniquement le
 * fichier + la niche. Le système extrait le texte (PDF), génère un
 * titre-accroche + description via Sonnet 5, trouve une image de
 * couverture via Pexels, uploade le fichier sur Cloudinary, et crée le
 * contenu en status='brouillon' — invisible côté client tant que l'admin
 * n'a pas cliqué "Publier" (PATCH /academy/:id/publish ci-dessous).
 * L'admin peut éditer le titre/description générés avant publication via
 * le PATCH /academy/:id classique.
 */
adminRouter.post(
  '/academy/auto-upload',
  requireRole('admin'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          type: z.enum(['pdf', 'video']),
          niche: z.string().min(1),
          access: z.enum(['gratuit', 'payant']).default('gratuit'),
          creditsCost: z.coerce.number().min(0).optional(),
          formationId: z.string().optional(),
          formationTitle: z.string().optional(),
        })
        .parse(req.body);

      if (!req.file) throw new AppError('Fichier manquant (champ "file")', 400);
      if (body.type === 'pdf' && req.file.mimetype !== 'application/pdf') {
        throw new AppError('Le fichier doit être un PDF', 400);
      }
      if (body.type === 'video' && !req.file.mimetype.startsWith('video/')) {
        throw new AppError('Le fichier doit être une vidéo', 400);
      }

      const draft = await buildAutoDraft({
        kind: 'academy',
        niche: body.niche,
        filename: req.file.originalname,
        fileType: body.type,
        buffer: req.file.buffer,
      });

      const publicId =
        body.type === 'pdf'
          ? await uploadAcademyPdf(req.file.buffer, req.file.originalname)
          : await uploadAcademyVideo(req.file.buffer, req.file.originalname);

      const content = await AcademyContent.create({
        title: draft.title,
        description: draft.description,
        imageUrl: draft.imageUrl,
        niche: body.niche,
        type: body.type,
        access: body.access,
        creditsCost: body.creditsCost,
        hosting: 'cloudinary',
        sourceUrl: publicId,
        formationId: body.formationId,
        formationTitle: body.formationTitle,
        status: 'brouillon',
      });

      res.status(201).json({ content });
    } catch (err) {
      next(err);
    }
  }
);

/** Publie un contenu Academy (brouillon → visible côté client). */
adminRouter.patch(
  '/academy/:id/publish',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const content = await AcademyContent.findByIdAndUpdate(
        req.params.id,
        { status: 'publié' },
        { new: true }
      );
      if (!content) throw new AppError('Contenu introuvable', 404);
      res.json({ content });
    } catch (err) {
      next(err);
    }
  }
);

/** Repasse un contenu Academy en brouillon (dépublication). */
adminRouter.patch(
  '/academy/:id/unpublish',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const content = await AcademyContent.findByIdAndUpdate(
        req.params.id,
        { status: 'brouillon' },
        { new: true }
      );
      if (!content) throw new AppError('Contenu introuvable', 404);
      res.json({ content });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Régénère titre + description (IA) pour des contenus Academy DÉJÀ
 * PUBLIÉS — action manuelle déclenchée par l'admin (jamais automatique,
 * contrairement à l'auto-upload). `ids` optionnel : liste précise de
 * contenus à retraiter ; omis ou vide = tous les contenus publiés,
 * quel qu'en soit le nombre. Boutique n'est JAMAIS touchée par cette route
 * (voir /boutique/regenerer-titres, séparée).
 */
adminRouter.post(
  '/academy/regenerer-titres',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
      const filter: Record<string, unknown> = { status: 'publié' };
      if (body.ids && body.ids.length > 0) filter._id = { $in: body.ids };

      const contents = await AcademyContent.find(filter);
      const updated: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const content of contents) {
        try {
          const { title, description } = await regenerateTitleAndDescription({
            kind: 'academy',
            niche: content.niche || 'général',
            currentTitle: content.title,
            currentDescription: content.description,
          });
          content.title = title;
          content.description = description;
          await content.save();
          updated.push(String(content._id));
        } catch (err) {
          failed.push({ id: String(content._id), error: err instanceof Error ? err.message : 'Erreur inconnue' });
        }
      }

      res.json({ total: contents.length, updated: updated.length, failed });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/academy',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          title: z.string().min(1),
          type: z.enum(['video', 'pdf']),
          access: z.enum(['gratuit', 'payant']),
          creditsCost: z.number().min(0).optional(),
          hosting: z.enum(['cloudinary', 'embed_externe']).default('cloudinary'),
          sourceUrl: z.string().min(1),
          category: z.string().optional(),
          formationId: z.string().optional(),
          formationTitle: z.string().optional(),
          description: z.string().optional(),
        })
        .refine((b) => !(b.type === 'pdf' && b.hosting === 'embed_externe'), {
          message: 'Un PDF doit obligatoirement être hébergé sur Cloudinary (pas d\'embed externe)',
        })
        .parse(req.body);

      const content = await AcademyContent.create(body);
      res.status(201).json({ content });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/academy/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          title: z.string().min(1).optional(),
          type: z.enum(['video', 'pdf']).optional(),
          access: z.enum(['gratuit', 'payant']).optional(),
          creditsCost: z.number().min(0).optional(),
          hosting: z.enum(['cloudinary', 'embed_externe']).optional(),
          sourceUrl: z.string().min(1).optional(),
          category: z.string().optional(),
          formationId: z.string().optional(),
          formationTitle: z.string().optional(),
          description: z.string().optional(),
        })
        .parse(req.body);

      const existing = await AcademyContent.findById(req.params.id).select('+sourceUrl');
      if (!existing) throw new AppError('Contenu introuvable', 404);

      // Si on remplace le fichier Cloudinary par un autre, on nettoie l'ancien
      // (best-effort, ne bloque jamais la mise à jour en cas d'échec).
      if (
        body.sourceUrl &&
        body.sourceUrl !== existing.sourceUrl &&
        existing.hosting === 'cloudinary'
      ) {
        void deleteAcademyResource(existing.sourceUrl, existing.type === 'video' ? 'video' : 'raw');
      }

      const content = await AcademyContent.findByIdAndUpdate(req.params.id, body, {
        new: true,
      }).select('+sourceUrl');
      if (!content) throw new AppError('Contenu introuvable', 404);
      res.json({ content });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.delete(
  '/academy/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await AcademyContent.findById(req.params.id).select('+sourceUrl');
      if (!deleted) throw new AppError('Contenu introuvable', 404);

      if (deleted.hosting === 'cloudinary') {
        void deleteAcademyResource(deleted.sourceUrl, deleted.type === 'video' ? 'video' : 'raw');
      }

      await AcademyContent.findByIdAndDelete(req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Boutique CRUD ───────────────────────────────────────

/**
 * Upload direct d'un fichier Boutique (PDF, vidéo, image ou archive) depuis
 * l'admin — même principe que /academy/upload. Renvoie un cloudinaryPublicId
 * à réutiliser tel quel dans le POST /boutique ci-dessous.
 *
 * Champ attendu : type = 'pdf' | 'video' | 'image' | 'archive'
 */
adminRouter.post(
  '/boutique/upload',
  requireRole('admin'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = z.enum(['pdf', 'video', 'image', 'archive']).parse(req.body.type);
      if (!req.file) throw new AppError('Fichier manquant (champ "file")', 400);

      if (type === 'pdf' && req.file.mimetype !== 'application/pdf') {
        throw new AppError('Le fichier doit être un PDF', 400);
      }
      if (type === 'video' && !req.file.mimetype.startsWith('video/')) {
        throw new AppError('Le fichier doit être une vidéo', 400);
      }
      if (type === 'image' && !req.file.mimetype.startsWith('image/')) {
        throw new AppError('Le fichier doit être une image', 400);
      }

      const publicId = await uploadBoutiqueProduct(req.file.buffer, req.file.originalname, type);

      res.status(201).json({ cloudinaryPublicId: publicId, type });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get(
  '/boutique',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const products = await BoutiqueProduct.find().sort({ createdAt: -1 });
      res.json({ products });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/boutique',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          title: z.string().min(1),
          description: z.string().optional(),
          isFreeForSubscriber: z.boolean().default(false),
          creditsCost: z.number().min(0).default(0),
          audience: z.enum(['starter_formation', 'all_paid', 'everyone']).default('all_paid'),
          type: z.enum(['pdf', 'video', 'image', 'archive']).default('pdf'),
          cloudinaryPublicId: z.string().min(1),
        })
        .parse(req.body);

      const product = await BoutiqueProduct.create(body);
      res.status(201).json({ product });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Régénère titre + description (IA) pour des produits Boutique DÉJÀ
 * PUBLIÉS — action manuelle déclenchée par l'admin, jamais automatique.
 * `ids` optionnel : produits précis à retraiter ; omis ou vide = tous les
 * produits publiés, quel qu'en soit le nombre. Academy n'est JAMAIS
 * touchée par cette route (voir /academy/regenerer-titres, séparée).
 */
adminRouter.post(
  '/boutique/regenerer-titres',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
      const filter: Record<string, unknown> = { status: 'publié' };
      if (body.ids && body.ids.length > 0) filter._id = { $in: body.ids };

      const products = await BoutiqueProduct.find(filter);
      const updated: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const product of products) {
        try {
          const { title, description } = await regenerateTitleAndDescription({
            kind: 'boutique',
            niche: product.niche || 'général',
            currentTitle: product.title,
            currentDescription: product.description,
          });
          product.title = title;
          product.description = description;
          await product.save();
          updated.push(String(product._id));
        } catch (err) {
          failed.push({ id: String(product._id), error: err instanceof Error ? err.message : 'Erreur inconnue' });
        }
      }

      res.json({ total: products.length, updated: updated.length, failed });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/boutique/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          isFreeForSubscriber: z.boolean().optional(),
          creditsCost: z.number().min(0).optional(),
          audience: z.enum(['starter_formation', 'all_paid', 'everyone']).optional(),
          type: z.enum(['pdf', 'video', 'image', 'archive']).optional(),
          cloudinaryPublicId: z.string().min(1).optional(),
          // Publication possible depuis l'édition, en plus des routes
          // dédiées /publish et /unpublish.
          status: z.enum(['brouillon', 'publié']).optional(),
        })
        .parse(req.body);

      const existingProduct = await BoutiqueProduct.findById(req.params.id);
      if (!existingProduct) throw new AppError('Produit introuvable', 404);

      // Si on remplace le fichier par un autre, on nettoie l'ancien sur
      // Cloudinary (best-effort, ne bloque jamais la mise à jour).
      if (body.cloudinaryPublicId && body.cloudinaryPublicId !== existingProduct.cloudinaryPublicId) {
        // PDF comme ZIP sont des ressources « raw » chez Cloudinary.
        const oldResourceType = 'raw' as const;
        void deleteBoutiqueResource(existingProduct.cloudinaryPublicId, oldResourceType);
      }

      const product = await BoutiqueProduct.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!product) throw new AppError('Produit introuvable', 404);
      res.json({ product });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.delete(
  '/boutique/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await BoutiqueProduct.findByIdAndDelete(req.params.id);
      if (!deleted) throw new AppError('Produit introuvable', 404);
      const resourceType = 'raw' as const;
      void deleteBoutiqueResource(deleted.cloudinaryPublicId, resourceType);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /admin/users/:id (plan + crédits en un appel — contrat frontend) ─

adminRouter.patch(
  '/users/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          plan: z.enum(['trial', 'starter', 'createur', 'agence', 'pro_max', 'essai']).optional(),
          creditsBalance: z.number().int().min(0).optional(),
          grantPlanCredits: z.boolean().optional().default(false),
        })
        .parse(req.body);

      const user = await User.findById(req.params.id);
      if (!user) throw new AppError('Utilisateur introuvable', 404);

      if (body.plan) {
        // Frontend peut envoyer 'essai' → mapper vers trial
        const plan = (body.plan === 'essai' ? 'trial' : body.plan) as UserPlan;
        user.plan = plan;
        if (plan !== 'trial') user.trialEndsAt = undefined;
      }

      if (body.creditsBalance != null) {
        const delta = body.creditsBalance - user.creditsBalance;
        if (delta !== 0) {
          if (delta > 0) {
            await creditCredits(user._id, delta, 'ajustement_admin', {
              note: 'admin_patch_credits',
            });
          } else {
            const abs = Math.abs(delta);
            user.creditsBalance = Math.max(0, user.creditsBalance - abs);
            const { CreditTransaction } = await import('@/models/CreditTransaction');
            await CreditTransaction.create({
              userId: user._id,
              type: 'ajustement_admin',
              amount: -abs,
              balanceAfter: user.creditsBalance,
              note: 'admin_patch_credits',
            });
          }
        }
      }

      await user.save();

      if (body.grantPlanCredits && body.plan) {
        const plan = (body.plan === 'essai' ? 'trial' : body.plan) as string;
        const amount = PLAN_CREDITS[plan] ?? 0;
        if (amount > 0) {
          await creditCredits(user._id, amount, 'ajustement_admin', { note: `plan:${plan}` });
        }
      }

      const refreshed = await User.findById(user._id).select(
        'email role plan trialEndsAt creditsBalance domainsUsed createdAt'
      );
      res.json({ user: refreshed });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Paiements clients : alias anglais ────────────────────────
//
// Mêmes données que /paiements et /paiements/:id/paye, exposées sous les
// chemins anglais utilisés par le frontend (lib/api.ts → adminApi.payments).
// Les deux formes doivent rester synchronisées : toute évolution de l'une
// doit être reportée sur l'autre.
//
// Il s'agit des paiements encaissés par les CLIENTS sur leurs propres sites,
// avec la commission NexAI et le reversement à effectuer — pas des
// abonnements ni des achats de crédits, qui passent par le webhook Chariow.

adminRouter.get(
  '/payments',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const statut = req.query.statut as string | undefined;
      const filter = statut ? { statut } : {};
      const paiements = await PaiementChariow.find(filter)
        .populate('siteId', 'domainName niche userId')
        .sort({ webhookReceivedAt: -1 })
        .limit(200);
      // Shape attendu par le frontend : payments avec status/paid
      const payments = paiements.map((p) => {
        const doc = p.toObject ? p.toObject() : p;
        return {
          id: String((doc as { _id: unknown })._id),
          userEmail: (doc as { customerEmail?: string }).customerEmail,
          amount: (doc as { amount?: number }).amount,
          status:
            (doc as { statut?: string }).statut === 'paye'
              ? 'paid'
              : (doc as { statut?: string }).statut === 'echec'
                ? 'failed'
                : 'pending',
          createdAt: (doc as { createdAt?: Date }).createdAt,
          method: 'chariow',
          raw: doc,
        };
      });
      res.json({ payments, paiements });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/payments/:id/mark-paid',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paiement = await markPaiementPaye(req.params.id);
      res.json({ paiement });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Avis (témoignages landing) CRUD ──────────────────────

adminRouter.get(
  '/avis',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { Avis } = await import('@/models/Avis');
      const avis = await Avis.find().sort({ order: 1, createdAt: -1 });
      res.json({ avis });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/avis',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Avis } = await import('@/models/Avis');
      const body = z
        .object({
          name: z.string().min(1).max(120),
          role: z.string().min(1).max(120),
          content: z.string().min(1).max(2000),
          rating: z.number().int().min(1).max(5).default(5),
          active: z.boolean().optional().default(true),
          order: z.number().int().optional(),
        })
        .parse(req.body);
      const avis = await Avis.create(body);
      res.status(201).json({ avis });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/avis/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Avis } = await import('@/models/Avis');
      const body = z
        .object({
          name: z.string().min(1).max(120).optional(),
          role: z.string().min(1).max(120).optional(),
          content: z.string().min(1).max(2000).optional(),
          rating: z.number().int().min(1).max(5).optional(),
          active: z.boolean().optional(),
          order: z.number().int().optional(),
        })
        .parse(req.body);
      const avis = await Avis.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!avis) throw new AppError('Avis introuvable', 404);
      res.json({ avis });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.delete(
  '/avis/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { Avis } = await import('@/models/Avis');
      const deleted = await Avis.findByIdAndDelete(req.params.id);
      if (!deleted) throw new AppError('Avis introuvable', 404);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Instructions complémentaires chat (admin) ───────────
// Ne modifient PAS les règles anti (verrouillées backend). Chargées en bas
// du prompt Haiku à chaque tour.

adminRouter.get(
  '/chat-instructions',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        AppConfig,
        CHAT_ADMIN_INSTRUCTIONS_KEY,
        CHAT_ADMIN_INSTRUCTIONS_MAX_LEN,
      } = await import('@/models/AppConfig');
      const doc = await AppConfig.findOne({ key: CHAT_ADMIN_INSTRUCTIONS_KEY }).lean();
      res.json({
        instructions: doc?.value || '',
        maxLength: CHAT_ADMIN_INSTRUCTIONS_MAX_LEN,
        updatedAt: doc?.updatedAt || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/chat-instructions',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        AppConfig,
        CHAT_ADMIN_INSTRUCTIONS_KEY,
        CHAT_ADMIN_INSTRUCTIONS_MAX_LEN,
      } = await import('@/models/AppConfig');

      const body = z
        .object({
          instructions: z.string().max(CHAT_ADMIN_INSTRUCTIONS_MAX_LEN),
        })
        .parse(req.body);

      const text = body.instructions.trim();

      // Rejet de patterns d'injection / contournement des règles anti
      const forbidden = [
        /ignore\s+(previous|all|above)\s+instructions/i,
        /tu\s+es\s+claude/i,
        /you\s+are\s+(claude|anthropic|gpt|openai)/i,
        /disregard\s+(the\s+)?(system|previous)/i,
        /forget\s+(your\s+)?(rules|instructions)/i,
        /révèle\s+(tes|vos)\s+(instructions|règles)/i,
        /reveal\s+(your\s+)?(system\s+)?prompt/i,
      ];
      for (const re of forbidden) {
        if (re.test(text)) {
          throw new AppError(
            'Instructions rejetées : pattern non autorisé (contournement des règles anti).',
            400
          );
        }
      }

      const doc = await AppConfig.findOneAndUpdate(
        { key: CHAT_ADMIN_INSTRUCTIONS_KEY },
        { $set: { value: text } },
        { upsert: true, new: true }
      );

      res.json({
        instructions: doc.value,
        maxLength: CHAT_ADMIN_INSTRUCTIONS_MAX_LEN,
        updatedAt: doc.updatedAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Prompt IA admin bac à sable (0 crédit, hors flux client) ─────────

adminRouter.post(
  '/ia-prompt',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          message: z.string().min(1).max(8000),
          context: z.string().max(20000).optional(),
        })
        .parse(req.body);

      const { callGrok, callClaude } = await import('@/services/ai-clients');

      const system =
        'Tu es l\'assistant admin NexAI. Réponds de façon claire et actionnable. ' +
        (body.context ? `\nContexte fourni:\n${body.context}` : '');

      let reply: string;
      try {
        reply = await callGrok(
          'grok-4.5',
          [
            { role: 'system', content: system },
            { role: 'user', content: body.message },
          ],
          { maxTokens: 4000, temperature: 0.4 }
        );
      } catch {
        // Fallback Claude
        reply = await callClaude(
          'claude-sonnet-5',
          system,
          [{ role: 'user', content: body.message }],
          { maxTokens: 4000, temperature: 0.4 }
        );
      }

      res.json({ reply });
    } catch (err) {
      next(err);
    }
  }
);


// ─── Support chat clients (tickets) ──────────────────────

adminRouter.get(
  '/support/tickets',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const tickets = await listTicketsForAdmin(status);
      res.json({ tickets });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.get(
  '/support/tickets/:id',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ticket = await getTicketForAdmin(req.params.id);
      res.json({ ticket });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/support/tickets/:id/reply',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);
      const ticket = await adminReply(req.params.id, body.content);
      res.json({ ticket });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/support/tickets/:id/close',
  requireRole('admin', 'support'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ticket = await closeTicket(req.params.id);
      res.json({ ticket });
    } catch (err) {
      next(err);
    }
  }
);


// ══════════════════════════════════════════════════════════════════
// MÉTHODE DE RETRAIT — file de reversement (Architecture v6, section 12)
// Le reversement réel est TOUJOURS manuel : NexAI ne déclenche aucun
// virement automatique. L'admin effectue le versement de son côté
// (Mobile Money / USDT BEP-20 / BTC), puis l'enregistre ici.
// ══════════════════════════════════════════════════════════════════

/** Liste des clients ayant un solde dû > 0, du plus gros au plus petit. */
adminRouter.get(
  '/reversements',
  requireRole('admin', 'finance'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const clients = await listerClientsAReverser();
      res.json({ clients });
    } catch (err) {
      next(err);
    }
  }
);

/** Historique + solde détaillé d'un client précis. */
adminRouter.get(
  '/reversements/:userId',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [solde, historique] = await Promise.all([
        getSoldeReversement(req.params.userId),
        getHistoriqueReversement(req.params.userId, 200),
      ]);
      res.json({ solde, historique });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * "Marquer comme reversé" — enregistre un versement réellement effectué.
 * Refuse tout montant supérieur au solde dû (protection contre la double
 * saisie qui ferait croire au client qu'il a été payé deux fois).
 */
adminRouter.post(
  '/reversements/:userId/marquer-reverse',
  requireRole('admin', 'finance'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          amountFcfa: z.number().positive(),
          reference: z.string().max(200).optional(),
          note: z.string().max(500).optional(),
          dateVersement: z.coerce.date().optional(),
        })
        .parse(req.body);

      const entry = await marquerCommeReverse({
        userId: req.params.userId,
        amountFcfa: body.amountFcfa,
        reference: body.reference,
        note: body.note,
        adminEmail: req.auth!.email ?? 'admin',
        dateVersement: body.dateVersement,
      });

      const solde = await getSoldeReversement(req.params.userId);
      res.status(201).json({ entry, solde });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// QUALITÉ — rapport et seuil négatif NexAI (Architecture v6, section 18)
// Seuil négatif = MOYENNE de 3 taux (avis négatifs, sites échoués, vidéos
// rejetées). Déclenchement du diagnostic de prompts à 40%.
// ══════════════════════════════════════════════════════════════════

/**
 * GET /quality-report — rapport qualité complet.
 * Accessible à l'admin ET à Claude Code (agent Fable) via la même route :
 * c'est la source unique dont Fable a besoin pour décider s'il doit lancer
 * un diagnostic de prompts.
 */
adminRouter.get(
  '/quality-report',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jours = req.query.jours ? Math.min(Number(req.query.jours), 365) : 30;
      const rapport = await buildRapportQualite(jours);
      res.json(rapport);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// ALERTES QUALITÉ GÉNÉRATION (section 18)
// Essai gratuit  → information seule, site déjà livré, aucune action.
// Payant         → le site attend la décision admin : Valider ou Refuser.
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/alertes-qualite',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const statut = typeof req.query.statut === 'string' ? req.query.statut : 'ouverte';
      const alertes = await AlerteQualite.find({ statut })
        .sort({ type: 1, createdAt: -1 }) // 'attente_action' avant 'information'
        .limit(200)
        .lean();

      res.json({
        alertes: alertes.map((a) => ({
          id: String(a._id),
          siteId: String(a.siteId),
          type: a.type,
          statut: a.statut,
          niche: a.niche,
          plan: a.plan,
          verdictJuges: a.verdictJuges ?? [],
          // Score affiché à titre informatif — jamais la raison de l'alerte.
          score: a.score ?? null,
          date: a.createdAt,
          actionRequise: a.type === 'attente_action' && a.statut === 'ouverte',
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /alertes-qualite/:id/valider — le client reçoit le site tel quel. */
adminRouter.post(
  '/alertes-qualite/:id/valider',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const alerte = await AlerteQualite.findById(req.params.id);
      if (!alerte) throw new AppError('Alerte introuvable.', 404);
      if (alerte.statut !== 'ouverte') {
        throw new AppError('Cette alerte a déjà été traitée.', 400);
      }

      const site = await Site.findById(alerte.siteId);
      if (site) {
        // Le site sort de l'attente et devient consultable par le client.
        site.status = 'ready';
        await site.save();
      }

      alerte.statut = 'validee';
      alerte.traitePar = 'admin';
      alerte.traiteA = new Date();
      await alerte.save();

      await logEvent({
        categorie: 'alerte_qualite',
        niveau: 'info',
        message: `Alerte validée — site livré au client (niche ${alerte.niche})`,
        siteId: alerte.siteId,
        userId: alerte.userId,
      });

      res.json({ alerte });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /alertes-qualite/:id/refuser — relance COMPLÈTE de la génération
 * depuis le Codeur. Le client recevra ses nouveaux aperçus une fois prêts.
 */
adminRouter.post(
  '/alertes-qualite/:id/refuser',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const alerte = await AlerteQualite.findById(req.params.id);
      if (!alerte) throw new AppError('Alerte introuvable.', 404);
      if (alerte.statut !== 'ouverte') {
        throw new AppError('Cette alerte a déjà été traitée.', 400);
      }

      const site = await Site.findById(alerte.siteId);
      if (!site) throw new AppError('Site introuvable.', 404);

      // Relance du pipeline complet, sans re-débiter le client : il a déjà
      // payé cette génération, l'échec vient de nous.
      site.status = 'generating';
      site.proposals = [];
      await site.save();
      const job = await pipelineQueue.add('generate-site', {
        siteId: String(site._id),
        userId: String(alerte.userId),
        skipDebit: true,
      });

      alerte.statut = 'refusee';
      alerte.traitePar = 'admin';
      alerte.traiteA = new Date();
      alerte.relanceJobId = String(job.id);
      await alerte.save();

      await logEvent({
        categorie: 'alerte_qualite',
        niveau: 'warn',
        message: `Alerte refusée — regénération relancée (niche ${alerte.niche})`,
        siteId: alerte.siteId,
        userId: alerte.userId,
        contexte: { jobId: String(job.id) },
      });

      res.json({ alerte, relanceJobId: String(job.id) });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// PROMPTS — diagnostic Fable + rédaction Sonnet (section 18)
// « Prompt actif » vs « Prompt amélioré ». Valider / Refuser / Remettre
// l'ancien. Silence 1h = Fable applique automatiquement.
// ══════════════════════════════════════════════════════════════════

/** GET /prompts/candidats — propositions en attente de décision. */
adminRouter.get(
  '/prompts/candidats',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const candidats = await getCandidatsEnAttente();
      res.json({ candidats });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /prompts/diagnostic — lance l'analyse (déclenchée aussi par le seuil). */
adminRouter.post(
  '/prompts/diagnostic',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const forcer = req.body?.forcer === true;
      const resultat = await lancerDiagnosticPrompts({ forcer });
      res.json(resultat);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /prompts/:id/valider — la proposition devient le prompt actif. */
adminRouter.post(
  '/prompts/:id/valider',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = await appliquerCandidat(req.params.id, req.auth!.email ?? 'admin');
      res.json({ version });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /prompts/:id/refuser — l'ancien prompt reste actif. */
adminRouter.post(
  '/prompts/:id/refuser',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = await refuserCandidat(req.params.id, req.auth!.email ?? 'admin');
      res.json({ version });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /prompts/:id/restaurer — remet une version antérieure en service. */
adminRouter.post(
  '/prompts/:id/restaurer',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const version = await restaurerVersion(req.params.id, req.auth!.email ?? 'admin');
      res.json({ version });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /prompts/historique — versions successives d'une cible. */
adminRouter.get(
  '/prompts/historique',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cible = String(req.query.cible || '') as PromptCible;
      if (!cible) throw new AppError('Paramètre "cible" requis.', 400);
      const niche = req.query.niche ? String(req.query.niche) : null;
      const historique = await getHistoriquePrompts(cible, niche);
      res.json({ historique });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// ÉQUIPE IA — bascule de modèle par rôle (section 3)
// Limitée aux alternatives réellement compatibles avec chaque poste.
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/equipe-ia',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const roles = await listAiTeamConfig();
      res.json({ roles });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/equipe-ia/:role',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ model: z.string().min(1) }).parse(req.body);
      await setModelForRole(
        req.params.role as AiRole,
        body.model,
        req.auth!.email ?? 'admin'
      );
      const roles = await listAiTeamConfig();

      await logEvent({
        categorie: 'ia',
        niveau: 'info',
        message: `Modèle du rôle "${req.params.role}" basculé vers ${body.model}`,
      });

      res.json({ roles });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// LOGS — journal technique + envoi email (section 18)
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/logs',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtre: Record<string, unknown> = {};
      if (req.query.categorie) filtre.categorie = String(req.query.categorie);
      if (req.query.niveau) filtre.niveau = String(req.query.niveau);

      const logs = await SystemLog.find(filtre)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(req.query.limit) || 100, 500))
        .lean();

      res.json({
        logs: logs.map((l) => ({
          id: String(l._id),
          date: l.createdAt,
          categorie: l.categorie,
          niveau: l.niveau,
          message: l.message,
          contexte: l.contexte ?? null,
        })),
        // Adresse vers laquelle chaque événement est aussi expédié.
        emailDestination: env.ADMIN_EMAIL ?? null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// BOUTIQUE — publication (Architecture v6, section 13)
// Un produit reste en brouillon (invisible côté client) tant qu'il n'a pas
// été publié explicitement. Le prix en crédits doit être défini AVANT la
// publication — 0 = gratuit, sinon montant fixé par l'admin.
// ══════════════════════════════════════════════════════════════════

adminRouter.patch(
  '/boutique/:id/publish',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const produit = await BoutiqueProduct.findById(req.params.id);
      if (!produit) throw new AppError('Produit introuvable', 404);

      // Garde-fou : sans prix défini, le produit serait affiché au client
      // sans indication de coût. 0 est une valeur valide (produit offert),
      // mais l'absence de valeur ne l'est pas.
      if (produit.creditsCost === undefined || produit.creditsCost === null) {
        throw new AppError(
          "Définissez le prix en crédits avant de publier (0 = produit gratuit).",
          400
        );
      }
      if (!produit.cloudinaryPublicId) {
        throw new AppError("Aucun fichier n'est associé à ce produit.", 400);
      }

      produit.status = 'publié';
      await produit.save();

      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `Produit Boutique publié : ${produit.title} (${produit.creditsCost} crédits)`,
      });

      res.json({ produit });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/boutique/:id/unpublish',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const produit = await BoutiqueProduct.findById(req.params.id);
      if (!produit) throw new AppError('Produit introuvable', 404);

      // Retour en brouillon : le produit disparaît immédiatement du
      // catalogue client, sans être supprimé (les achats déjà effectués
      // restent valides et accessibles à leurs acheteurs).
      produit.status = 'brouillon';
      await produit.save();

      res.json({ produit });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /avis/generer — bouton « Générer des avis avec Sonnet ».
 * L'admin indique le nombre voulu (jusqu'à 20 par clic, relançable).
 * Les avis créés sont marqués 'genere_admin' et n'entrent JAMAIS dans le
 * calcul du seuil qualité.
 */
adminRouter.post(
  '/avis/generer',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ nombre: z.coerce.number().min(1).max(20).default(5) }).parse(req.body);
      const resultat = await genererAvis(body.nombre);

      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `${resultat.crees} avis vitrine générés par Sonnet`,
      });

      res.status(201).json(resultat);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /avis/stats — répartition avis clients / générés, et note moyenne réelle. */
adminRouter.get(
  '/avis/stats',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [clients, generes, negatifsClients, moyenne] = await Promise.all([
        Avis.countDocuments({ source: 'client' }),
        Avis.countDocuments({ source: 'genere_admin' }),
        Avis.countDocuments({ source: 'client', rating: { $lte: 2 } }),
        Avis.aggregate<{ _id: null; avg: number }>([
          { $match: { source: 'client' } },
          { $group: { _id: null, avg: { $avg: '$rating' } } },
        ]),
      ]);

      res.json({
        avisClients: clients,
        avisGeneres: generes,
        avisClientsNegatifs: negatifsClients,
        noteMoyenneClients: moyenne[0]?.avg ? Number(moyenne[0].avg.toFixed(2)) : null,
        // Rappel explicite : seuls les avis clients pèsent sur la qualité.
        note: "Seuls les avis clients entrent dans le calcul du seuil négatif NexAI.",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// COMPTE & SÉCURITÉ (Administration)
// Changement de l'email administrateur : le 1er sans code (l'adresse
// initiale est une adresse de travail), tous les suivants avec un code
// envoyé au NOUVEL email.
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/securite',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getStatutSecurite());
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/securite/email',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ nouvelEmail: z.string().email() }).parse(req.body);
      const r = await demanderChangementEmail(body.nouvelEmail, req.auth!.userId);
      await logEvent({
        categorie: 'action_admin',
        niveau: 'warn',
        message: r.applique
          ? `Email administrateur changé vers ${body.nouvelEmail}`
          : `Demande de changement d'email administrateur vers ${body.nouvelEmail} (code envoyé)`,
      });
      res.json(r);
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/securite/email/confirmer',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ code: z.string().min(4).max(12) }).parse(req.body);
      const r = await confirmerChangementEmail(body.code, req.auth!.userId);
      await logEvent({
        categorie: 'action_admin',
        niveau: 'warn',
        message: `Email administrateur confirmé et basculé vers ${r.emailActuel}`,
      });
      res.json(r);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// SÉCURITÉ & MAINTENANCE — incidents plateforme
// Fable diagnostique, l'admin décide, l'agent externe répare.
// Le backend ne modifie jamais son propre code.
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/incidents',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtre: Record<string, unknown> = {};
      if (req.query.statut) filtre.statut = String(req.query.statut);
      const incidents = await PlatformAlert.find(filtre)
        .sort({ derniereOccurrence: -1 })
        .limit(100)
        .lean();
      res.json({
        incidents: incidents.map((i) => ({
          id: String(i._id),
          statut: i.statut,
          gravite: i.gravite,
          composant: i.composant,
          erreur: i.erreur,
          contexte: i.contexte ?? null,
          occurrences: i.occurrences,
          causeProbable: i.causeProbable ?? null,
          pisteCorrection: i.pisteCorrection ?? null,
          fichiersSuspects: i.fichiersSuspects ?? [],
          derniereOccurrence: i.derniereOccurrence,
          compteRenduAgent: i.compteRenduAgent ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Approuve la réparation : l'incident entre dans la file de l'agent externe. */
adminRouter.post(
  '/incidents/:id/approuver',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inc = await PlatformAlert.findById(req.params.id);
      if (!inc) throw new AppError('Incident introuvable.', 404);
      inc.statut = 'approuve';
      inc.decidePar = req.auth!.email ?? 'admin';
      inc.decideA = new Date();
      await inc.save();
      res.json({ incident: inc });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/incidents/:id/refuser',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inc = await PlatformAlert.findById(req.params.id);
      if (!inc) throw new AppError('Incident introuvable.', 404);
      inc.statut = 'refuse';
      inc.decidePar = req.auth!.email ?? 'admin';
      inc.decideA = new Date();
      await inc.save();
      res.json({ incident: inc });
    } catch (err) {
      next(err);
    }
  }
);

/** Marque un incident comme résolu (réparation faite, ou plus d'actualité). */
adminRouter.post(
  '/incidents/:id/resolu',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inc = await PlatformAlert.findById(req.params.id);
      if (!inc) throw new AppError('Incident introuvable.', 404);
      inc.statut = 'resolu';
      inc.resoluA = new Date();
      await inc.save();
      res.json({ incident: inc });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// BOUTIQUE — PACKS (Architecture v6, section 13)
// La Boutique s'organise en packs (« Pack 1 — plus de 200 produits
// digitaux »...). L'admin les crée librement et y range les PDF.
// ══════════════════════════════════════════════════════════════════

adminRouter.get(
  '/boutique/packs',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const packs = await BoutiquePack.find().sort({ ordre: 1, createdAt: 1 }).lean();
      const compte = await BoutiqueProduct.aggregate<{ _id: unknown; total: number }>([
        { $match: { packId: { $ne: null } } },
        { $group: { _id: '$packId', total: { $sum: 1 } } },
      ]);
      const parPack = new Map(compte.map((c) => [String(c._id), c.total]));
      res.json({
        packs: packs.map((p) => ({
          id: String(p._id),
          titre: p.titre,
          sousTitre: p.sousTitre ?? '',
          description: p.description ?? '',
          creditsCost: p.creditsCost,
          ordre: p.ordre,
          status: p.status,
          nbProduits: parPack.get(String(p._id)) ?? 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.post(
  '/boutique/packs',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          titre: z.string().min(1).max(120),
          sousTitre: z.string().max(200).optional(),
          description: z.string().max(1000).optional(),
          creditsCost: z.coerce.number().min(0).default(0),
          ordre: z.coerce.number().default(0),
        })
        .parse(req.body);
      const pack = await BoutiquePack.create({ ...body, status: 'brouillon' });
      res.status(201).json({ pack });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch(
  '/boutique/packs/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          titre: z.string().min(1).max(120).optional(),
          sousTitre: z.string().max(200).optional(),
          description: z.string().max(1000).optional(),
          creditsCost: z.coerce.number().min(0).optional(),
          ordre: z.coerce.number().optional(),
          status: z.enum(['brouillon', 'publié']).optional(),
        })
        .parse(req.body);
      const pack = await BoutiquePack.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!pack) throw new AppError('Pack introuvable.', 404);
      res.json({ pack });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.delete(
  '/boutique/packs/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const produits = await BoutiqueProduct.countDocuments({ packId: req.params.id });
      if (produits > 0) {
        // Suppression refusée tant que le pack contient des produits :
        // sinon ils deviendraient inaccessibles sans être supprimés.
        throw new AppError(
          `Ce pack contient ${produits} produit(s). Déplacez-les ou supprimez-les d'abord.`,
          409
        );
      }
      const pack = await BoutiquePack.findByIdAndDelete(req.params.id);
      if (!pack) throw new AppError('Pack introuvable.', 404);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /boutique/packs/:id/import — import d'un lot de PDF.
 *
 * Accepte soit une ARCHIVE ZIP (décompressée ici, chaque PDF devient un
 * produit), soit plusieurs FICHIERS sélectionnés d'un coup. Les deux
 * chemins aboutissent au même résultat : des produits rangés dans le pack.
 */
adminRouter.post(
  '/boutique/packs/:id/import',
  requireRole('admin'),
  upload.array('fichiers', 50),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pack = await BoutiquePack.findById(req.params.id);
      if (!pack) throw new AppError('Pack introuvable.', 404);

      const fichiers = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (fichiers.length === 0) throw new AppError('Aucun fichier reçu.', 400);

      const body = z
        .object({
          creditsCost: z.coerce.number().min(0).default(0),
          audience: z.enum(['starter_formation', 'all_paid', 'everyone']).default('all_paid'),
        })
        .parse(req.body ?? {});

      const AdmZip = (await import('adm-zip')).default;
      const aCreer: { nom: string; buffer: Buffer }[] = [];

      for (const f of fichiers) {
        const estZip =
          f.mimetype === 'application/zip' ||
          f.mimetype === 'application/x-zip-compressed' ||
          f.originalname.toLowerCase().endsWith('.zip');

        if (estZip) {
          // Archive : on extrait uniquement les PDF, en ignorant les
          // dossiers et les fichiers système (__MACOSX, .DS_Store...).
          const zip = new AdmZip(f.buffer);
          for (const entree of zip.getEntries()) {
            if (entree.isDirectory) continue;
            const nom = entree.entryName.split('/').pop() ?? '';
            if (!nom.toLowerCase().endsWith('.pdf')) continue;
            if (nom.startsWith('.') || entree.entryName.includes('__MACOSX')) continue;
            aCreer.push({ nom, buffer: entree.getData() });
          }
        } else if (f.originalname.toLowerCase().endsWith('.pdf')) {
          aCreer.push({ nom: f.originalname, buffer: f.buffer });
        }
        // Tout autre format est ignoré : la Boutique ne contient que des PDF.
      }

      if (aCreer.length === 0) {
        throw new AppError("Aucun PDF trouvé dans les fichiers envoyés.", 400);
      }

      const crees: string[] = [];
      const echecs: string[] = [];
      for (const item of aCreer) {
        try {
          const publicId = await uploadBoutiqueProduct(item.buffer, item.nom, 'pdf');
          // Titre lisible dérivé du nom de fichier (sans extension ni tirets)
          const titre = item.nom
            .replace(/\.pdf$/i, '')
            .replace(/[-_]+/g, ' ')
            .trim()
            .slice(0, 120);
          await BoutiqueProduct.create({
            packId: pack._id,
            title: titre || item.nom,
            type: 'pdf',
            cloudinaryPublicId: publicId,
            creditsCost: body.creditsCost,
            audience: body.audience,
            isFreeForSubscriber: body.creditsCost === 0,
            status: 'brouillon',
          });
          crees.push(titre);
        } catch {
          echecs.push(item.nom);
        }
      }

      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `Import Boutique : ${crees.length} PDF ajoutés au pack « ${pack.titre} »`,
      });

      res.status(201).json({
        packId: String(pack._id),
        crees: crees.length,
        echecs,
        // Les produits arrivent en brouillon : l'admin les publie ensuite.
        note: 'Les produits importés sont en brouillon. Publiez-les pour les rendre visibles.',
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PACKS ACADÉMIE
//
// L'Académie accepte deux formes d'ajout :
//   · un contenu SEUL  → POST /academy (contenu sans packId)
//   · un PACK          → POST /academy/packs puis POST /academy/packs/:id/import
//
// L'import accepte indifféremment une archive ZIP ou plusieurs fichiers
// déposés ensemble : les deux aboutissent au même résultat, un pack contenant
// les fichiers exploitables.
// ─────────────────────────────────────────────────────────────────────────────

/** Liste des packs Académie (admin). */
adminRouter.get(
  '/academy/packs',
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const packs = await AcademyPack.find().sort({ ordre: 1, createdAt: 1 }).lean();
      const counts = await AcademyContent.aggregate([
        { $match: { packId: { $ne: null } } },
        { $group: { _id: '$packId', n: { $sum: 1 } } },
      ]);
      const parPack = new Map<string, number>(counts.map((c) => [String(c._id), c.n as number]));
      res.json({
        packs: packs.map((p: { _id: unknown }) => ({
          ...p,
          contenus: parPack.get(String(p._id)) ?? 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Création d'un pack Académie (vide : les contenus arrivent par l'import). */
adminRouter.post(
  '/academy/packs',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          titre: z.string().min(1).max(160),
          sousTitre: z.string().max(200).optional(),
          description: z.string().max(4000).optional(),
          creditsCost: z.coerce.number().min(0).default(0),
          access: z.enum(['gratuit', 'payant']).default('gratuit'),
          ordre: z.coerce.number().default(0),
          imageUrl: z.string().url().optional(),
          category: z.string().max(120).optional(),
        })
        .parse(req.body ?? {});

      const pack = await AcademyPack.create(body);
      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `Pack Académie créé : « ${pack.titre} »`,
      });
      res.status(201).json({ pack });
    } catch (err) {
      next(err);
    }
  }
);

/** Modification d'un pack Académie. */
adminRouter.patch(
  '/academy/packs/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          titre: z.string().min(1).max(160).optional(),
          sousTitre: z.string().max(200).optional(),
          description: z.string().max(4000).optional(),
          creditsCost: z.coerce.number().min(0).optional(),
          access: z.enum(['gratuit', 'payant']).optional(),
          ordre: z.coerce.number().optional(),
          imageUrl: z.string().url().optional(),
          category: z.string().max(120).optional(),
          status: z.enum(['brouillon', 'publié']).optional(),
        })
        .parse(req.body ?? {});

      const pack = await AcademyPack.findByIdAndUpdate(req.params.id, body, { new: true });
      if (!pack) throw new AppError('Pack introuvable.', 404);
      res.json({ pack });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Suppression d'un pack Académie.
 *
 * Les contenus qu'il regroupait ne sont PAS supprimés : ils redeviennent des
 * contenus autonomes. Supprimer un pack est un geste d'organisation, pas une
 * destruction de fichiers — les effacer serait irréversible et rarement voulu.
 */
adminRouter.delete(
  '/academy/packs/:id',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pack = await AcademyPack.findByIdAndDelete(req.params.id);
      if (!pack) throw new AppError('Pack introuvable.', 404);
      const { modifiedCount } = await AcademyContent.updateMany(
        { packId: pack._id },
        { $unset: { packId: '' } }
      );
      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `Pack Académie supprimé : « ${pack.titre} » (${modifiedCount} contenu(s) rendus autonomes)`,
      });
      res.json({ ok: true, contenusLiberes: modifiedCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Import de contenus dans un pack Académie.
 *
 * Accepte, dans le même champ `fichiers` :
 *   · une archive ZIP (son contenu exploitable est extrait) ;
 *   · plusieurs fichiers déposés ensemble ;
 *   · un mélange des deux.
 *
 * Les formats retenus sont les PDF et les vidéos — une image seule n'est pas
 * un contenu de formation, elle est ignorée. Les contenus arrivent en
 * brouillon : l'administrateur les publie ensuite, d'un seul geste.
 */
adminRouter.post(
  '/academy/packs/:id/import',
  requireRole('admin'),
  upload.array('fichiers', 50),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pack = await AcademyPack.findById(req.params.id);
      if (!pack) throw new AppError('Pack introuvable.', 404);

      const recus = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (recus.length === 0) throw new AppError('Aucun fichier reçu.', 400);

      const body = z
        .object({
          creditsCost: z.coerce.number().min(0).optional(),
          access: z.enum(['gratuit', 'payant']).optional(),
          niche: z.string().max(120).optional(),
        })
        .parse(req.body ?? {});

      // Archives et fichiers directs ramenés à une même liste.
      const aCreer: PackFile[] = [];
      for (const f of recus) {
        if (estArchiveZip(f.mimetype, f.originalname)) {
          aCreer.push(...extraireArchive(f.buffer));
        } else {
          const type = typeDepuisNom(f.originalname);
          if (type) aCreer.push({ filename: f.originalname, buffer: f.buffer, type });
        }
      }

      // L'Académie ne diffuse que des PDF et des vidéos.
      const retenus = aCreer.filter((f) => f.type === 'pdf' || f.type === 'video');
      if (retenus.length === 0) {
        throw new AppError('Aucun PDF ni vidéo trouvé dans les fichiers envoyés.', 400);
      }

      const accesPack = body.access ?? pack.access;
      const coutPack = body.creditsCost ?? pack.creditsCost;

      const crees: string[] = [];
      const echecs: string[] = [];
      for (const item of retenus) {
        try {
          const publicId =
            item.type === 'pdf'
              ? await uploadAcademyPdf(item.buffer, item.filename)
              : await uploadAcademyVideo(item.buffer, item.filename);

          await AcademyContent.create({
            packId: pack._id,
            title: titreDepuisNomFichier(item.filename).slice(0, 160),
            type: item.type,
            access: accesPack,
            creditsCost: accesPack === 'payant' ? coutPack : 0,
            status: 'brouillon',
            niche: body.niche,
            hosting: 'cloudinary',
            sourceUrl: publicId,
          });
          crees.push(item.filename);
        } catch {
          echecs.push(item.filename);
        }
      }

      await logEvent({
        categorie: 'action_admin',
        niveau: 'info',
        message: `Import Académie : ${crees.length} contenu(s) ajoutés au pack « ${pack.titre} »`,
      });

      res.status(201).json({
        packId: String(pack._id),
        crees: crees.length,
        echecs,
        note: 'Les contenus importés sont en brouillon. Publiez-les pour les rendre visibles.',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Publication (ou dépublication) de TOUS les contenus d'un pack en une fois.
 *
 * Évite d'avoir à publier chaque fichier un par un après un import de
 * plusieurs dizaines de contenus.
 */
adminRouter.post(
  '/academy/packs/:id/publish',
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ publier: z.boolean().default(true) }).parse(req.body ?? {});
      const pack = await AcademyPack.findById(req.params.id);
      if (!pack) throw new AppError('Pack introuvable.', 404);

      const statut = body.publier ? 'publié' : 'brouillon';
      const { modifiedCount } = await AcademyContent.updateMany(
        { packId: pack._id },
        { $set: { status: statut } }
      );
      pack.status = statut;
      await pack.save();

      res.json({ ok: true, statut, contenus: modifiedCount });
    } catch (err) {
      next(err);
    }
  }
);
