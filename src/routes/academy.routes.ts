import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth';
import { AcademyContent } from '@/models/AcademyContent';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { getAcademyResourceUrl } from '@/services/cloudinary.service';
import { signAcademyViewToken, verifyAcademyViewToken } from '@/services/academy-viewer.service';
import { watermarkPdfBuffer } from '@/services/pdf-watermark.service';

export const academyRouter = Router();

const PLANS_FULL_ACADEMY = new Set(['starter', 'createur', 'agence', 'pro_max']);

/** Vérifie que l'utilisateur a accès à ce contenu Académie à l'instant T (plan actuel). */
async function assertAccess(userId: string, content: { access: string }) {
  const user = await User.findById(userId).select('plan email');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  const fullAccess = PLANS_FULL_ACADEMY.has(user.plan);
  if (content.access === 'payant' && !fullAccess) {
    throw new AppError('Contenu réservé aux abonnés (Starter et plus)', 403);
  }
  return user;
}

academyRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const contents = await AcademyContent.find()
      .select('-sourceUrl')
      .sort({ createdAt: -1 });

    const fullAccess = PLANS_FULL_ACADEMY.has(user.plan);

    const visible = contents.map((c) => {
      const locked = !fullAccess && c.access === 'payant';
      return {
        id: c._id,
        title: c.title,
        type: c.type,
        access: c.access,
        category: c.category,
        formationId: c.formationId,
        formationTitle: c.formationTitle,
        description: c.description,
        locked,
      };
    });

    res.json({ contents: visible, plan: user.plan, fullAccess });
  } catch (err) {
    next(err);
  }
});

/**
 * Renvoie les métadonnées + un token de vue courte durée (2 min), jamais
 * l'URL réelle du fichier. Le frontend doit ensuite appeler /:id/stream
 * (pdf) ou /:id/video-stream (vidéo hébergée Cloudinary) avec ce token.
 */
academyRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const content = await AcademyContent.findById(req.params.id).select('+sourceUrl');
    if (!content) throw new AppError('Contenu introuvable', 404);

    await assertAccess(req.auth!.userId, content);

    const viewToken = signAcademyViewToken({
      userId: req.auth!.userId,
      contentId: String(content._id),
      purpose: content.type === 'video' ? 'video' : 'pdf',
    });

    if (content.type === 'video') {
      if (content.hosting === 'embed_externe') {
        res.json({
          id: content._id,
          title: content.title,
          type: 'video',
          hosting: 'embed_externe',
          embedHint: content.sourceUrl,
        });
      } else {
        res.json({
          id: content._id,
          title: content.title,
          type: 'video',
          hosting: 'cloudinary',
          streamUrl: `/api/v1/academy/${content._id}/video-stream?token=${viewToken}`,
        });
      }
    } else {
      res.json({
        id: content._id,
        title: content.title,
        type: 'pdf',
        streamUrl: `/api/v1/academy/${content._id}/stream?token=${viewToken}`,
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Sert les octets du PDF — jamais l'URL Cloudinary au client. Vérifie le
 * token courte durée + revérifie l'accès (plan) au moment de servir, ajoute
 * un filigrane nominatif (email + date) sur chaque page, et empêche la mise
 * en cache par les proxys/CDN intermédiaires.
 *
 * Limite connue : le lecteur PDF natif du navigateur affiche toujours un
 * bouton "Enregistrer" une fois le flux reçu. L'empêcher complètement
 * nécessite un rendu canvas côté frontend (pdf.js) — voir la note envoyée
 * séparément sur le viewer sécurisé.
 */
academyRouter.get('/:id/stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) throw new AppError('Token de visionnage manquant', 401);

    verifyAcademyViewToken(token, {
      userId: req.auth!.userId,
      contentId: req.params.id,
      purpose: 'pdf',
    });

    const content = await AcademyContent.findById(req.params.id).select('+sourceUrl');
    if (!content || content.type !== 'pdf') throw new AppError('Contenu introuvable', 404);

    const user = await assertAccess(req.auth!.userId, content);

    if (content.hosting !== 'cloudinary') {
      throw new AppError('Hébergement PDF non supporté pour le streaming', 500);
    }

    const internalUrl = getAcademyResourceUrl(content.sourceUrl, 'raw');
    const upstream = await fetch(internalUrl);
    if (!upstream.ok) throw new AppError('Fichier introuvable côté stockage', 502);

    const original = Buffer.from(await upstream.arrayBuffer());
    const watermarked = await watermarkPdfBuffer(original, `${user.email} — NexAI Académie`);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="document.pdf"',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res.send(watermarked);
  } catch (err) {
    next(err);
  }
});

/**
 * Sert (en streaming, avec support Range pour la lecture progressive) une
 * vidéo Académie hébergée sur Cloudinary. Même logique de token courte durée
 * + revérification d'accès que pour les PDF.
 */
academyRouter.get('/:id/video-stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) throw new AppError('Token de visionnage manquant', 401);

    verifyAcademyViewToken(token, {
      userId: req.auth!.userId,
      contentId: req.params.id,
      purpose: 'video',
    });

    const content = await AcademyContent.findById(req.params.id).select('+sourceUrl');
    if (!content || content.type !== 'video' || content.hosting !== 'cloudinary') {
      throw new AppError('Contenu introuvable', 404);
    }

    await assertAccess(req.auth!.userId, content);

    const internalUrl = getAcademyResourceUrl(content.sourceUrl, 'video');
    const range = req.headers.range;
    const upstream = await fetch(internalUrl, range ? { headers: { range } } : undefined);
    if (!upstream.ok && upstream.status !== 206) {
      throw new AppError('Fichier introuvable côté stockage', 502);
    }

    res.status(upstream.status);
    res.set({
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      'Cache-Control': 'no-store, private',
      'Accept-Ranges': 'bytes',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    const contentRange = upstream.headers.get('content-range');
    const contentLength = upstream.headers.get('content-length');
    if (contentRange) res.set('Content-Range', contentRange);
    if (contentLength) res.set('Content-Length', contentLength);

    const body = upstream.body;
    if (!body) throw new AppError('Flux vidéo vide', 502);
    const reader = body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    next(err);
  }
});
