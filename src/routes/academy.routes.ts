import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth';
import { AcademyContent, IAcademyContent } from '@/models/AcademyContent';
import { AcademyPack } from '@/models/AcademyPack';
import { AcademyDomaine } from '@/models/AcademyDomaine';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { getAcademyResourceUrl } from '@/services/cloudinary.service';
import { signAcademyViewToken, verifyAcademyViewToken } from '@/services/academy-viewer.service';
import { watermarkPdfBuffer } from '@/services/pdf-watermark.service';
import { lienLectureSigne } from '@/services/bunny-stream.service';
import {
  assurerCatalogue,
  badgePratique,
  estVerrouillee,
  statutAcademie,
  StatutAcademie,
} from '@/services/academy-programme.service';
import {
  ACADEMY_MODULES,
  ACADEMY_POLES,
  TEXTES_VENTE,
  TOTAL_DOMAINES,
  TOTAL_FORMATIONS_PREVUES,
} from '@/data/academy-modules';
import type { HydratedDocument } from 'mongoose';

export const academyRouter = Router();

/**
 * ACADÉMIE — côté client (structure validée le 25/09/2026)
 *
 *   Domaine → Formation → Leçons, rangées en :
 *     Partie 1 « Les bases »          (bases)
 *     Partie 2 « Formation complète » (complet = Comprendre, pratique = Phase pratique, kit = Kit Expert)
 *
 * Accès (option C) — appliqué ICI, par le serveur :
 *   · Essai 7 jours : vidéos IA « bases » + « complet » ouvertes ; pratique et kit verrouillés.
 *   · Après l'essai sans abonnement : tout est visible, rien ne s'ouvre.
 *   · Abonné (Starter et +) : tout.
 *
 * Rien de vide n'est envoyé au client : une formation sans leçon publiée, un
 * domaine sans formation remplie n'existent pas pour lui. Aucune vidéo YouTube.
 */

const ORDRE_PARTIES: Record<string, number> = { bases: 1, complet: 2, pratique: 3, kit: 4 };

/** Filtre des leçons visibles côté client. */
const FILTRE_LECONS = {
  status: 'publié',
  partie: { $in: ['bases', 'complet', 'pratique', 'kit'] },
  hosting: { $in: ['bunny', 'cloudinary'] },
  packId: { $exists: true, $ne: null },
};

function trierLecons<T extends { partie?: string; ordre?: number; createdAt?: Date }>(liste: T[]): T[] {
  return [...liste].sort(
    (a, b) =>
      (ORDRE_PARTIES[a.partie || ''] ?? 9) - (ORDRE_PARTIES[b.partie || ''] ?? 9) ||
      (a.ordre ?? 0) - (b.ordre ?? 0) ||
      new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
  );
}

/** Crédit à afficher : obligatoire pour une licence Creative Commons, jamais pour NexAI / marque blanche. */
function creditDe(c: Pick<IAcademyContent, 'attribution'>) {
  const a = c.attribution;
  if (!a || !a.licence || a.licence === 'nexai' || a.licence === 'fournisseur') return null;
  return a;
}

async function chargerLecteur(userId: string) {
  const user = await User.findById(userId).select('plan planExpiresAt trialEndsAt role email');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  return { user, statut: statutAcademie(user) };
}

/** Chiffres publics (page d'accueil) — sans connexion. Toujours vrais, calculés en direct. */
academyRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const lecons = await AcademyContent.countDocuments({ ...FILTRE_LECONS, type: 'video' });
    res.json({ domaines: TOTAL_DOMAINES, formations: TOTAL_FORMATIONS_PREVUES, lecons });
  } catch (err) {
    next(err);
  }
});

/** Liste officielle des pôles et domaines (sans contenu). */
academyRouter.get('/modules', requireAuth, (_req: Request, res: Response) => {
  res.json({
    poles: ACADEMY_POLES,
    modules: ACADEMY_MODULES.map(({ formations, ...m }) => ({ ...m, formations: formations.length })),
  });
});

/** Le catalogue complet, déjà filtré et verrouillé pour CE client. */
academyRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await assurerCatalogue();
    const { user, statut } = await chargerLecteur(req.auth!.userId);

    const [lecons, packs, domainesDb] = await Promise.all([
      AcademyContent.find(FILTRE_LECONS).sort({ ordre: 1, createdAt: 1 }),
      AcademyPack.find({ status: 'publié' }).lean(),
      AcademyDomaine.find().lean(),
    ]);

    const packsParId = new Map(packs.map((p) => [String(p._id), p]));
    const leconsParFormation = new Map<string, typeof lecons>();
    for (const l of lecons) {
      const pid = String(l.packId);
      if (!packsParId.has(pid)) continue;
      if (!leconsParFormation.has(pid)) leconsParFormation.set(pid, []);
      leconsParFormation.get(pid)!.push(l);
    }

    const formations = packs
      .filter((p) => leconsParFormation.has(String(p._id)) && p.module)
      .map((p) => {
        const liste = trierLecons(leconsParFormation.get(String(p._id))!);
        const reservee = p.access === 'payant';
        return {
          id: String(p._id),
          slug: p.slug,
          domaine: p.module,
          titre: p.titre,
          accroche: p.accroche || p.sousTitre || '',
          description: p.description || '',
          pratique: p.pratique || '',
          imageUrl: p.imageUrl,
          imagePhotographe: p.imagePhotographe,
          ordre: p.ordre,
          badgePratique: badgePratique(liste.filter((l) => l.partie === 'pratique').map((l) => l.genre)),
          aKit: liste.some((l) => l.partie === 'kit'),
          lecons: liste.map((l) => ({
            id: String(l._id),
            titre: l.title,
            description: l.description,
            type: l.type,
            partie: l.partie,
            genre: l.genre,
            duree: l.duree,
            ordre: l.ordre ?? 0,
            locked: estVerrouillee(l, statut, reservee),
            credit: creditDe(l),
          })),
        };
      })
      .sort((a, b) => a.ordre - b.ordre);

    const domainesAvecContenu = new Set(formations.map((f) => f.domaine));
    const textesDomaines = new Map(domainesDb.map((d) => [d.slug, d]));
    const domaines = ACADEMY_MODULES.filter((m) => domainesAvecContenu.has(m.slug)).map((m) => {
      const t = textesDomaines.get(m.slug);
      const sesFormations = formations.filter((f) => f.domaine === m.slug);
      return {
        slug: m.slug,
        titre: m.titre,
        emoji: m.emoji,
        pole: m.pole,
        ordre: m.ordre,
        accroche: t?.accroche || m.accroche,
        description: t?.description || m.description,
        imageUrl: t?.imageUrl,
        imagePhotographe: t?.imagePhotographe,
        nbFormations: sesFormations.length,
        nbLecons: sesFormations.reduce((n, f) => n + f.lecons.filter((l) => l.type === 'video').length, 0),
      };
    });

    res.json({
      statut,
      essaiFin: statut === 'essai' ? user.trialEndsAt ?? null : null,
      plan: user.plan,
      textes: TEXTES_VENTE,
      stats: {
        domaines: TOTAL_DOMAINES,
        formations: TOTAL_FORMATIONS_PREVUES,
        lecons: lecons.filter((l) => l.type === 'video' && packsParId.has(String(l.packId))).length,
      },
      poles: ACADEMY_POLES,
      domaines,
      formations,
    });
  } catch (err) {
    next(err);
  }
});

/** Charge une leçon et vérifie qu'elle est lisible par CE client, à l'instant T. */
async function chargerLecon(
  userId: string,
  contentId: string
): Promise<{
  content: HydratedDocument<IAcademyContent>;
  statut: StatutAcademie;
  email: string;
  estAdmin: boolean;
}> {
  const content = await AcademyContent.findById(contentId).select('+sourceUrl');
  if (!content) throw new AppError('Contenu introuvable', 404);
  const { user, statut } = await chargerLecteur(userId);
  const estAdmin = user.role === 'admin';
  const pack = content.packId ? await AcademyPack.findById(content.packId).select('access status') : null;
  // Un brouillon, ou une leçon hors formation publiée, ne s'ouvre que pour l'administrateur.
  if (!estAdmin && (content.status !== 'publié' || !pack || pack.status !== 'publié' || !content.partie)) {
    throw new AppError('Contenu introuvable', 404);
  }
  if (estVerrouillee(content, statut, pack?.access === 'payant')) {
    throw new AppError(
      statut === 'essai'
        ? 'La phase pratique et le Kit Expert se débloquent avec l’abonnement Starter.'
        : TEXTES_VENTE.finEssai,
      403
    );
  }
  return { content, statut, email: user.email, estAdmin };
}

/**
 * Métadonnées d'une leçon + de quoi la lire (jamais l'URL réelle du fichier) :
 *  · Bunny : lien de lecteur signé (token + expiration) ;
 *  · Cloudinary (vidéo) : flux par /:id/video-stream avec token court ;
 *  · Kit PDF : téléchargement par /:id/telecharger (abonnés).
 * Inclut la « leçon suivante » de la même formation.
 */
academyRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, statut } = await chargerLecon(req.auth!.userId, req.params.id);

    // Leçon suivante : même formation, ordre des parties puis des séances.
    let suivante: { id: string; titre: string; locked: boolean } | null = null;
    if (content.packId) {
      const pack = await AcademyPack.findById(content.packId).select('access titre module');
      const soeurs = trierLecons(
        await AcademyContent.find({ ...FILTRE_LECONS, packId: content.packId }).select('title partie genre ordre createdAt')
      );
      const i = soeurs.findIndex((s) => String(s._id) === String(content._id));
      const s = i >= 0 ? soeurs[i + 1] : undefined;
      if (s) {
        suivante = {
          id: String(s._id),
          titre: s.title,
          locked: estVerrouillee(s, statut, pack?.access === 'payant'),
        };
      }
    }

    const commun = {
      id: content._id,
      title: content.title,
      description: content.description,
      type: content.type,
      hosting: content.hosting,
      partie: content.partie,
      genre: content.genre,
      module: content.module || null,
      packId: content.packId ? String(content.packId) : null,
      duree: content.duree,
      credit: creditDe(content),
      suivante,
    };

    if (content.type === 'video') {
      if (content.hosting === 'bunny') {
        res.json({ ...commun, embedUrl: lienLectureSigne(content.sourceUrl) });
      } else {
        const viewToken = signAcademyViewToken({
          userId: req.auth!.userId,
          contentId: String(content._id),
          purpose: 'video',
        });
        res.json({ ...commun, streamUrl: `/api/v1/academy/${content._id}/video-stream?token=${viewToken}` });
      }
    } else {
      res.json({ ...commun, downloadUrl: `/api/v1/academy/${content._id}/telecharger` });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Téléchargement du kit PDF (abonnés) : chaque page porte le nom/email du
 * client et la date — le fichier reste à lui, le partage est dissuadé.
 */
academyRouter.get('/:id/telecharger', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, email } = await chargerLecon(req.auth!.userId, req.params.id);
    if (content.type !== 'pdf' || content.hosting !== 'cloudinary') throw new AppError('Aucun PDF à télécharger', 404);

    const upstream = await fetch(getAcademyResourceUrl(content.sourceUrl, 'raw'));
    if (!upstream.ok) throw new AppError('Fichier introuvable côté stockage', 502);
    const original = Buffer.from(await upstream.arrayBuffer());
    const date = new Date().toLocaleDateString('fr-FR');
    const marque = await watermarkPdfBuffer(original, `${email} — NexAI Académie — ${date}`);

    const nom =
      content.title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'kit-nexai';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${nom}.pdf"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(marque);
  } catch (err) {
    next(err);
  }
});

/**
 * Lecture d'un PDF dans le lecteur sécurisé (aperçu admin des kits, anciens
 * contenus). Même contrôle d'accès, filigrane nominatif, jamais mis en cache.
 */
academyRouter.get('/:id/stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) throw new AppError('Token de visionnage manquant', 401);
    verifyAcademyViewToken(token, { userId: req.auth!.userId, contentId: req.params.id, purpose: 'pdf' });

    const { content, email } = await chargerLecon(req.auth!.userId, req.params.id);
    if (content.type !== 'pdf' || content.hosting !== 'cloudinary') throw new AppError('Contenu introuvable', 404);

    const upstream = await fetch(getAcademyResourceUrl(content.sourceUrl, 'raw'));
    if (!upstream.ok) throw new AppError('Fichier introuvable côté stockage', 502);
    const watermarked = await watermarkPdfBuffer(Buffer.from(await upstream.arrayBuffer()), `${email} — NexAI Académie`);

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
 * Flux d'une vidéo encore hébergée sur Cloudinary (vidéos envoyées avant
 * Bunny), avec support Range pour la lecture progressive.
 */
academyRouter.get('/:id/video-stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) throw new AppError('Token de visionnage manquant', 401);
    verifyAcademyViewToken(token, { userId: req.auth!.userId, contentId: req.params.id, purpose: 'video' });

    const { content } = await chargerLecon(req.auth!.userId, req.params.id);
    if (content.type !== 'video' || content.hosting !== 'cloudinary') throw new AppError('Contenu introuvable', 404);

    const range = req.headers.range;
    const upstream = await fetch(
      getAcademyResourceUrl(content.sourceUrl, 'video'),
      range ? { headers: { range } } : undefined
    );
    if (!upstream.ok && upstream.status !== 206) throw new AppError('Fichier introuvable côté stockage', 502);

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
