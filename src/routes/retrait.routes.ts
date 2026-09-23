import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { validatePaymentLink } from '@/services/payment-link.service';
import { getSoldeReversement, getHistoriqueReversement } from '@/services/reversement.service';

export const retraitRouter = Router();

/**
 * Méthode de retrait — page dédiée côté client (Architecture v6, section 12).
 * Page SÉPARÉE dans la navigation, jamais enfouie dans Paramètres.
 *
 * Deux options exclusives :
 *  1. Compte NexAI    — NexAI encaisse puis reverse (Mobile Money / USDT BEP-20 / BTC).
 *                       Cliquer dessus affiche les statistiques + le tableau
 *                       de paiement du client (solde, historique).
 *  2. Lien personnel  — le client encaisse directement (Chariow, Maketou,
 *                       Stripe, autre). NexAI n'intervient jamais.
 */

/**
 * GET / — état complet de la méthode de retrait du client, incluant les
 * statistiques du Compte NexAI (affichées dès que le client ouvre l'option).
 */
/**
 * Méthode de retrait ET lien de paiement personnel : Créateur+ et au-dessus
 * (Agence, Pro Max), plus le compte administrateur. Ni l'essai gratuit, ni
 * Starter — même en appelant l'API directement.
 */
const PLANS_RETRAIT = ['createur', 'agence', 'pro_max'];
function aDroitRetrait(u: { plan?: string; role?: string }): boolean {
  return u.role === 'admin' || PLANS_RETRAIT.includes(String(u.plan));
}

retraitRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select(
      'plan role defaultPaymentMode personalPaymentLink personalPaymentProvider compteReversement'
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    // Statistiques Compte NexAI — toujours renvoyées pour que le frontend
    // puisse afficher le tableau immédiatement au clic sur l'option, sans
    // second aller-retour réseau.
    const solde = await getSoldeReversement(user._id);
    const historique = await getHistoriqueReversement(user._id);

    res.json({
      modeActif: user.defaultPaymentMode ?? 'nexai',
      compteNexai: {
        label: 'Recevoir via mon Compte NexAI',
        description:
          "Les paiements de vos visiteurs sont collectés par NexAI, qui vous reverse ensuite vos gains sur le moyen que vous choisissez (Mobile Money, USDT BEP-20 ou BTC). Pratique si vous n'avez pas encore votre propre compte marchand.",
        // Disponible à partir de Créateur+ (les plans sans création de site
        // n'ont pas de site pour encaisser quoi que ce soit).
        disponible: aDroitRetrait(user),
        coordonnees: user.compteReversement ?? null,
        statistiques: solde,
        historique,
      },
      lienPersonnel: {
        label: 'Utiliser mon lien de paiement personnel',
        description:
          "Vos visiteurs paient directement sur votre propre lien de paiement. L'argent arrive immédiatement sur votre compte — NexAI n'intervient à aucun moment dans cet encaissement.",
        disponible: aDroitRetrait(user),
        lien: user.personalPaymentLink ?? null,
        prestataire: user.personalPaymentProvider ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH / — enregistre le choix du client (mode + coordonnées associées).
 * Le lien personnel est VÉRIFIÉ réellement avant d'être accepté (HTTPS, DNS,
 * anti-SSRF, réponse HTTP) — voir payment-link.service.ts.
 */
retraitRouter.patch('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        mode: z.enum(['nexai', 'lien_personnel']),
        personalPaymentLink: z.string().url().optional(),
        personalPaymentProvider: z.enum(['chariow', 'maketou', 'stripe', 'autre']).optional(),
        compteReversement: z
          .object({
            type: z.enum(['mobile_money', 'crypto']),
            operateur: z.string().optional(),
            numero: z.string().optional(),
            cryptoType: z.enum(['usdt_bep20', 'btc']).optional(),
            cryptoAddress: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    if (!aDroitRetrait(user)) {
      throw new AppError(
        "La méthode de retrait est disponible à partir de l'abonnement Créateur+.",
        403
      );
    }

    if (body.mode === 'lien_personnel') {
      if (!body.personalPaymentLink) {
        throw new AppError('Indiquez le lien de paiement à utiliser sur vos sites.', 400);
      }
      // Vérification réelle du lien (jamais une simple validation de format) :
      // si le lien ne répond pas, le client ne peut pas encaisser — autant le
      // détecter maintenant plutôt qu'après une vente perdue.
      const check = await validatePaymentLink(body.personalPaymentLink);
      if (!check.valid) {
        throw new AppError(
          check.reason ?? "Ce lien de paiement ne répond pas. Vérifiez-le avant de l'enregistrer.",
          400
        );
      }
      user.personalPaymentLink = body.personalPaymentLink;
      user.personalPaymentProvider = body.personalPaymentProvider ?? 'autre';
    }

    if (body.mode === 'nexai') {
      if (!['createur', 'agence', 'pro_max'].includes(user.plan)) {
        throw new AppError(
          'Le Compte NexAI est disponible à partir de l\'abonnement Créateur+.',
          403
        );
      }
      const rev = body.compteReversement;
      if (!rev) {
        throw new AppError('Indiquez comment vous souhaitez recevoir vos reversements.', 400);
      }
      if (rev.type === 'mobile_money' && (!rev.operateur || !rev.numero)) {
        throw new AppError('Indiquez votre opérateur et votre numéro Mobile Money.', 400);
      }
      if (rev.type === 'crypto' && (!rev.cryptoType || !rev.cryptoAddress)) {
        throw new AppError(
          'Indiquez le réseau (USDT BEP-20 ou BTC) et votre adresse — un mauvais réseau fait perdre les fonds.',
          400
        );
      }
      user.compteReversement = rev;
    }

    user.defaultPaymentMode = body.mode;
    await user.save();

    res.json({
      modeActif: user.defaultPaymentMode,
      lien: user.personalPaymentLink ?? null,
      prestataire: user.personalPaymentProvider ?? null,
      coordonnees: user.compteReversement ?? null,
    });
  } catch (err) {
    next(err);
  }
});
