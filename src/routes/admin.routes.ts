import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth, requireRole } from '@/middleware/auth';
import { User, UserPlan } from '@/models/User';
import { Site } from '@/models/Site';
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
        'mode format status creditsCharged qcReport relaunchOffer isRelaunchOf createdAt'
      );

      const finished = videos.filter((v) => v.status === 'completed' || v.status === 'refunded' || v.status === 'failed');
      const refunded = videos.filter((v) => v.status === 'refunded');
      const completed = videos.filter((v) => v.status === 'completed');
      const degraded = completed.filter((v) => v.qcReport?.degraded);
      const relaunchesUsed = completed.filter((v) => v.relaunchOffer?.used);

      const creditsPerdus = refunded.reduce((sum, v) => sum + (v.creditsCharged || 0), 0);
      const coutReelPerduUsd = refunded.reduce((sum, v) => {
        const cout = estimateVideoAdRealCostUsd(v.mode, v.format);
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
        status: { $in: ['failed', 'pending_support'] },
      })
        .populate('userId', 'email')
        .sort({ updatedAt: -1 })
        .limit(50);
      res.json({ sites });
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
 * lors de la création/mise à jour du contenu — plus besoin de passer par le
 * dashboard Cloudinary séparément.
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
        })
        .parse(req.body);

      const existingProduct = await BoutiqueProduct.findById(req.params.id);
      if (!existingProduct) throw new AppError('Produit introuvable', 404);

      // Si on remplace le fichier par un autre, on nettoie l'ancien sur
      // Cloudinary (best-effort, ne bloque jamais la mise à jour).
      if (body.cloudinaryPublicId && body.cloudinaryPublicId !== existingProduct.cloudinaryPublicId) {
        const oldResourceType =
          existingProduct.type === 'video' ? 'video' : existingProduct.type === 'image' ? 'image' : 'raw';
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
      const resourceType = deleted.type === 'video' ? 'video' : deleted.type === 'image' ? 'image' : 'raw';
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

// ─── Alias paiements (frontend: /admin/payments + mark-paid) ─

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

