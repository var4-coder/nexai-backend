import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Site } from '@/models/Site';
import { VideoAd } from '@/models/VideoAd';
import { SiteSubmission } from '@/models/SiteSubmission';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { hashIp } from '@/utils/crypto';
import { sendLeadNotificationEmail } from '@/services/brevo.service';
import { enregistrerVisite } from '@/services/site-visits.service';
import { aUnAbonnementActif } from '@/utils/abonnement';

/**
 * Backend public consommé par les sites CLIENTS livrés (HTML statique ou
 * Next.js), potentiellement depuis n'importe quel nom de domaine — voir la
 * config CORS dédiée dans app.ts pour ce préfixe. Authentification légère
 * par clé publique par site (x-nexai-site-key), pas par JWT utilisateur :
 * ce sont des visiteurs anonymes du site du client, pas des comptes NexAI.
 */
export const publicRouter = Router();

// Limite dédiée, plus stricte que la limite globale, pour éviter le spam de
// formulaires depuis un site client (par IP, tous sites confondus).
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Trop de soumissions, réessayez plus tard.' } },
});

const submitSchema = z.object({
  type: z.enum(['contact', 'reservation', 'commande', 'avis', 'autre']).default('contact'),
  data: z.record(z.unknown()).refine((d) => Object.keys(d).length > 0, 'Données manquantes'),
});

publicRouter.post(
  '/sites/:siteId/submit',
  submitLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const siteKey = req.headers['x-nexai-site-key'];
      if (!siteKey || typeof siteKey !== 'string') {
        throw new AppError('Clé de site manquante', 401);
      }

      const site = await Site.findById(req.params.siteId);
      if (!site || !site.publicApiKey || site.publicApiKey !== siteKey) {
        throw new AppError('Site introuvable ou clé invalide', 401);
      }
      if (site.status !== 'launched') {
        throw new AppError("Ce site n'est pas en ligne actuellement", 403);
      }

      const body = submitSchema.parse(req.body);

      const submission = await SiteSubmission.create({
        siteId: site._id,
        type: body.type,
        data: body.data,
        ipHash: req.ip ? hashIp(req.ip) : undefined,
        userAgent: req.headers['user-agent'],
      });

      // Notification email best-effort — ne bloque jamais la réponse au visiteur.
      User.findById(site.userId)
        .then((owner) => {
          if (owner?.email) {
            return sendLeadNotificationEmail(owner.email, site.name || String(site._id), body.type, body.data);
          }
        })
        .catch((err) => console.error('[public.routes] notification email échouée', err));

      res.status(201).json({ ok: true, submissionId: submission._id });
    } catch (err) {
      next(err);
    }
  }
);

export default publicRouter;

/**
 * POST /visite — page vue d'un site client déployé.
 *
 * Appelée par le script injecté dans les sites en ligne. Route publique et
 * volontairement permissive : elle répond toujours 204, même en cas de
 * problème, pour ne jamais faire apparaître d'erreur dans la console du
 * visiteur ni ralentir le site du client.
 */
/**
 * GET /sites/:siteId/etat — ce que le site doit afficher, selon l'abonnement
 * de son propriétaire.
 *
 * Interrogé par le script injecté dans chaque site client. Il décide :
 *  - si les paiements en ligne sont possibles : toujours avec un lien de
 *    paiement personnel, seulement avec un abonnement actif via le compte
 *    NexAI ;
 *  - si la mention « Propulsé par NexAI » doit apparaître.
 *
 * Les paiements sont coupés AVANT tout achat, jamais après : bloquer au
 * moment du webhook laisserait l'argent de l'acheteur prélevé sans pouvoir
 * être reversé au commerçant.
 *
 * En cas d'erreur, la réponse est volontairement PERMISSIVE (paiements
 * actifs, pas de mention) : une panne passagère de NexAI ne doit jamais
 * empêcher un commerçant de vendre.
 */
publicRouter.get('/sites/:siteId/etat', async (req: Request, res: Response) => {
  try {
    const site = await Site.findById(req.params.siteId).select('userId publicApiKey paymentMode hebergement');
    const siteKey = req.headers['x-nexai-site-key'];
    if (!site || !site.publicApiKey || site.publicApiKey !== siteKey) {
      return res.json({ paiementsActifs: true, afficherMention: false });
    }
    const proprietaire = await User.findById(site.userId).select(
      'plan role planExpiresAt personalPaymentLink'
    );
    const actif = proprietaire ? aUnAbonnementActif(proprietaire) : true;
    // Seuls les liens https sont servis. Ce lien est inscrit dans un bouton
    // d'un site public : un lien « javascript: » permettrait d'exécuter du
    // code chez les visiteurs du commerçant.
    const lienBrut = proprietaire?.personalPaymentLink;
    const lienPerso = typeof lienBrut === 'string' && /^https:\/\//i.test(lienBrut) ? lienBrut : null;

    // Deux modes de paiement, deux règles :
    //  · Lien personnel : l'argent va directement au commerçant, sans passer
    //    par NexAI. Il fonctionne TOUJOURS, abonnement ou non.
    //  · Compte NexAI : NexAI encaisse puis reverse. Ce service est lié à
    //    l'abonnement.
    //
    // Le lien est servi EN DIRECT : quand le commerçant le change dans son
    // espace, son site suit immédiatement, sans republication ni crédit.
    // Indispensable pour un abonné expiré, qui ne peut plus republier.
    //
    // `lienPaiement: null` signifie « garde le lien déjà inscrit dans la
    // page » : le site ne dépend donc jamais de NexAI pour encaisser.
    let etat: { paiementsActifs: boolean; lienPaiement: string | null };
    if (site.paymentMode === 'chariow') {
      if (actif) {
        etat = { paiementsActifs: true, lienPaiement: null };
      } else if (lienPerso) {
        // Abonnement expiré mais lien personnel disponible : le site bascule
        // tout seul dessus, et le commerçant continue de vendre.
        etat = { paiementsActifs: true, lienPaiement: lienPerso };
      } else {
        etat = { paiementsActifs: false, lienPaiement: null };
      }
    } else {
      etat = { paiementsActifs: true, lienPaiement: lienPerso };
    }

    // État d'hébergement, appliqué par le site lui-même. Le statut en base ne
    // retire rien chez l'hébergeur : sans ce relais, un site « suspendu »
    // resterait en réalité parfaitement accessible.
    const etape = site.hebergement?.etape;

    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.json({
      ...etat,
      afficherMention: !actif,
      modeLimite: etape === 'mode_limite' || etape === 'dernier_avertissement',
      suspendu: etape === 'suspendu',
    });
  } catch {
    return res.json({ paiementsActifs: true, afficherMention: false });
  }
});

/**
 * GET /galerie — vidéos d'exemple, visibles par tous, même sans compte.
 *
 * Ce sont de vraies productions NexAI, choisies par l'administrateur : le
 * visiteur juge la qualité réelle avant d'acheter. Seules les informations
 * utiles à l'affichage sont renvoyées, jamais le brief ni l'auteur.
 */
publicRouter.get('/galerie', async (_req: Request, res: Response) => {
  try {
    const videos = await VideoAd.find({ 'galerie.publie': true, status: 'completed' })
      .select('galerie finalVideoUrl thumbnailUrl format mode')
      .sort({ 'galerie.ordre': 1, createdAt: -1 })
      .limit(24)
      .lean();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      videos: videos
        .filter((v) => !!v.finalVideoUrl)
        .map((v) => ({
          id: String(v._id),
          titre: v.galerie?.titre ?? '',
          description: v.galerie?.description ?? '',
          categorie: v.galerie?.categorie ?? 'exemple',
          format: v.format,
          mode: v.mode,
          videoUrl: v.finalVideoUrl,
          miniatureUrl: v.thumbnailUrl ?? null,
        })),
    });
  } catch {
    // La galerie est une vitrine : en cas d'incident, une liste vide plutôt
    // qu'une erreur, pour ne jamais casser la page qui l'affiche.
    res.json({ videos: [] });
  }
});

publicRouter.post('/visite', async (req: Request, res: Response) => {
  // Réponse immédiate : l'enregistrement se poursuit en arrière-plan.
  res.status(204).end();

  try {
    const siteId = String(req.body?.siteId ?? '');
    if (!siteId || !/^[0-9a-f]{24}$/i.test(siteId)) return;

    await enregistrerVisite({
      siteId,
      chemin: typeof req.body?.chemin === 'string' ? req.body.chemin : '/',
      // L'IP sert uniquement à calculer une empreinte anonyme, elle n'est
      // jamais stockée (voir site-visits.service.ts).
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '',
      userAgent: String(req.headers['user-agent'] ?? ''),
      referer: typeof req.body?.referer === 'string' ? req.body.referer : undefined,
      pays: (req.headers['cf-ipcountry'] as string) || undefined,
    });
  } catch {
    // Silencieux : une statistique perdue ne doit jamais remonter au visiteur.
  }
});
