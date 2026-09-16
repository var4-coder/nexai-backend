import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Avis } from '@/models/Avis';
import { User } from '@/models/User';
import { requireAuth } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';

/**
 * Avis publics pour la landing — uniquement active: true.
 * Pas d'auth requise.
 */
export const avisRouter = Router();

avisRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const avis = await Avis.find({ active: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(50);
    res.json({ avis });
  } catch (err) {
    next(err);
  }
});

/**
 * POST / — un client connecté dépose son avis sur NexAI.
 * Alimente le petit bouton « Donner votre avis » de l'interface.
 *
 * Ces avis sont marqués source: 'client' : ce sont les SEULS comptés dans
 * l'indicateur qualité (seuil négatif 40%). Un avis négatif réel doit
 * pouvoir déclencher un diagnostic — c'est tout l'intérêt.
 */
avisRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        content: z.string().min(10).max(600),
        rating: z.number().int().min(1).max(5),
        role: z.string().max(120).optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId).select('email entrepriseNom');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    // Un seul avis par client : sinon un même compte pourrait peser
    // lourdement sur l'indicateur qualité en publiant en série.
    const existant = await Avis.findOne({ userId: user._id, source: 'client' });
    if (existant) {
      existant.content = body.content;
      existant.rating = body.rating;
      if (body.role) existant.role = body.role;
      await existant.save();
      res.json({ avis: existant, modifie: true });
      return;
    }

    // Nom affiché : l'entreprise si renseignée, sinon la partie avant @
    // de l'email — jamais l'adresse complète, qui est une donnée privée.
    const nomAffiche = user.entrepriseNom?.trim() || user.email.split('@')[0];

    const avis = await Avis.create({
      source: 'client',
      userId: user._id,
      name: nomAffiche,
      role: body.role ?? 'Client NexAI',
      content: body.content,
      rating: body.rating,
      active: true,
    });

    res.status(201).json({ avis, modifie: false });
  } catch (err) {
    next(err);
  }
});

/** GET /mien — l'avis déjà déposé par le client, pour pré-remplir le formulaire. */
avisRouter.get('/mien', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const avis = await Avis.findOne({ userId: req.auth!.userId, source: 'client' });
    res.json({ avis: avis ?? null });
  } catch (err) {
    next(err);
  }
});
