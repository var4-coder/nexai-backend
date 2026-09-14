import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';
import { uploadChatAttachment } from '@/services/cloudinary.service';
import {
  startChatSession,
  postChatMessage,
  confirmChatSession,
  getChatSession,
  switchChatMode,
  getBusinessCatalog,
} from '@/services/chat.service';

export const chatRouter = Router();

// Le chat appelle Haiku à chaque tour — limite dédiée, plus stricte que le
// rate limit global de app.ts, pour éviter l'abus (spam de messages).
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Upload de pièce jointe (image ou fichier) — jamais de vocal (Partie D — point 6).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
]);

chatRouter.post('/start', requireAuth, chatLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        clientId: z.string().optional(),
        mode: z.enum(['site', 'logo', 'edit', 'business']).optional().default('site'),
        editSiteId: z.string().optional(),
      })
      .parse(req.body ?? {});
    const session = await startChatSession(req.auth!.userId, {
      clientId: body.clientId,
      mode: body.mode,
      editSiteId: body.editSiteId,
    });
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

/** Catalogue Coach business (idées fixées) — public authentifié */
chatRouter.get('/business-catalog', requireAuth, (_req: Request, res: Response) => {
  res.json({ catalog: getBusinessCatalog() });
});

/**
 * Bascule le mode de la session en cours (site | logo | edit | business).
 * Body : { mode, editSiteId? }
 */
chatRouter.post(
  '/:id/switch-mode',
  requireAuth,
  chatLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          mode: z.enum(['site', 'logo', 'edit', 'business']),
          editSiteId: z.string().optional(),
        })
        .parse(req.body);
      const session = await switchChatMode(req.params.id, req.auth!.userId, body.mode, body.editSiteId);
      res.json({ session });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Upload d'une pièce jointe (image ou fichier) à joindre au prochain message
 * du chat. Renvoie l'URL Cloudinary à repasser dans POST /:id/message.
 */
chatRouter.post(
  '/:id/upload',
  requireAuth,
  chatLimiter,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Vérifie l'accès à la session avant tout upload (évite de stocker un
      // fichier pour une session qui n'appartient pas à l'utilisateur).
      await getChatSession(req.params.id, req.auth!.userId);

      const file = req.file;
      if (!file) throw new AppError('Aucun fichier reçu.', 400);
      if (!ALLOWED_MIME.has(file.mimetype)) {
        throw new AppError('Type de fichier non autorisé (image ou PDF uniquement).', 400);
      }
      const kind: 'image' | 'file' = file.mimetype.startsWith('image/') ? 'image' : 'file';
      const result = await uploadChatAttachment(file.buffer, file.originalname, kind);
      res.status(201).json({ url: result.url, type: kind, name: file.originalname });
    } catch (err) {
      next(err);
    }
  }
);

chatRouter.post(
  '/:id/message',
  requireAuth,
  chatLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z
        .object({
          reply: z.string().trim().max(2000).default(''),
          attachments: z
            .array(
              z.object({
                url: z.string().url(),
                type: z.enum(['image', 'file']),
                name: z.string().optional(),
              })
            )
            .max(5)
            .optional(),
        })
        .refine((v) => v.reply.length > 0 || (v.attachments && v.attachments.length > 0), {
          message: 'Message vide : ajoutez du texte ou une pièce jointe.',
        })
        .parse(req.body);
      const session = await postChatMessage(
        req.params.id,
        req.auth!.userId,
        body.reply || '(pièce jointe envoyée)',
        body.attachments
      );
      res.json({ session });
    } catch (err) {
      next(err);
    }
  }
);

chatRouter.post(
  '/:id/confirm',
  requireAuth,
  chatLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ confirmed: z.boolean() }).parse(req.body);
      const { session, site, pendingLogoAction } = await confirmChatSession(
        req.params.id,
        req.auth!.userId,
        body.confirmed
      );
      res.json({ session, site, pendingLogoAction });
    } catch (err) {
      next(err);
    }
  }
);

chatRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getChatSession(req.params.id, req.auth!.userId);
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

export default chatRouter;
