import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { requirePlan } from '@/middleware/requirePlan';
import {
  listClients,
  createClient,
  getClientWithSites,
  quickEditSite,
  getAgencyStats,
} from '@/services/agency.service';

/**
 * Espace Agence — voir nexai-frontend/lib/api.ts (agencyApi) et
 * GUIDE_INTEGRATION.md §4 pour le contrat attendu par le frontend.
 * Réservé aux plans `agence` et `pro_max`.
 */
export const agencyRouter = Router();

agencyRouter.use(requireAuth, requirePlan('agence', 'pro_max'));

const createClientSchema = z.object({
  nom: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  contactEmail: z.string().email().optional(),
  email: z.string().email().optional(),
  contactTelephone: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  notes: z.string().optional(),
}).refine((d) => !!(d.nom || d.name), { message: 'Le nom du client est requis' });

const quickEditSchema = z.object({
  textFields: z.record(z.string()).refine((obj) => Object.keys(obj).length > 0, {
    message: 'textFields ne peut pas être vide',
  }),
});

agencyRouter.get('/clients', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clients = await listClients(req.auth!.userId);
    res.json({ clients });
  } catch (err) {
    next(err);
  }
});

agencyRouter.post('/clients', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createClientSchema.parse(req.body);
    const client = await createClient(req.auth!.userId, body);
    res.status(201).json({ client });
  } catch (err) {
    next(err);
  }
});

agencyRouter.get('/clients/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { client, sites } = await getClientWithSites(req.auth!.userId, req.params.id);
    res.json({ client, sites });
  } catch (err) {
    next(err);
  }
});

agencyRouter.patch(
  '/sites/:siteId/quick-edit',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = quickEditSchema.parse(req.body);
      const { site, patchedIds, notFoundIds, redeployed } = await quickEditSite(
        req.auth!.userId,
        req.params.siteId,
        body.textFields
      );
      res.json({ site, patchedIds, notFoundIds, redeployed });
    } catch (err) {
      next(err);
    }
  }
);

agencyRouter.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await getAgencyStats(req.auth!.userId);
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});
