import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { getOrCreateThread, sendUserMessage } from '@/services/support.service';

export const supportRouter = Router();

supportRouter.get('/thread', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await getOrCreateThread(req.auth!.userId);
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
});

supportRouter.post(
  '/messages',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);
      const { ticket, escalated } = await sendUserMessage(req.auth!.userId, body.content);
      res.json({ ticket, escalated });
    } catch (err) {
      next(err);
    }
  }
);
