import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { AppError } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { CreditTransaction } from '@/models/CreditTransaction';
import { LANGUES_SUPPORTEES, isPaysSupporte } from '@/constants/pays';

export const usersRouter = Router();

usersRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        plan: user.plan,
        trialEndsAt: user.trialEndsAt,
        creditsBalance: user.creditsBalance,
        domainsUsed: user.domainsUsed ?? 0,
        logosUsed: user.logosUsed ?? 0,
        hasGoogle: Boolean(user.googleId),
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        defaultPaymentMode: user.defaultPaymentMode || 'nexai',
        personalPaymentLink: user.personalPaymentLink || '',
        personalPaymentProvider: user.personalPaymentProvider || '',
        compteReversement: user.compteReversement || null,
        // Préférence d'apparence — le frontend l'applique dès le chargement
        // pour éviter un "flash" de thème au démarrage.
        themePreference: user.themePreference || 'sombre',
        // Langue d'interface — le frontend l'applique dès le chargement, pour
        // la même raison que le thème (éviter un affichage en français puis un
        // basculement visible).
        langue: user.langue || 'fr',
        entrepriseNom: user.entrepriseNom || '',
        referralCode: user.referralCode || null,
        // Coordonnées paiement (Chariow) — enregistrées une fois, réutilisées
        prenom: user.prenom || '',
        nom: user.nom || '',
        telephone: user.telephone || '',
        telephonePays: user.telephonePays || '',
        // Compte admin : crédits illimités (jamais un chiffre, section 18)
        creditsIllimites: user.role === 'admin',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Coordonnées paiement (prénom, nom, téléphone) — une fois, modifiables ensuite */
usersRouter.patch('/me/contact', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        prenom: z.string().trim().min(1).max(80),
        nom: z.string().trim().min(1).max(80),
        telephone: z.string().trim().min(8).max(20),
        telephonePays: z.string().trim().min(2).max(4).optional(),
      })
      .parse(req.body);
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    user.prenom = body.prenom;
    user.nom = body.nom;
    user.telephone = body.telephone.replace(/\D/g, '');
    if (body.telephonePays) user.telephonePays = body.telephonePays.toUpperCase();
    await user.save();
    res.json({
      ok: true,
      prenom: user.prenom,
      nom: user.nom,
      telephone: user.telephone,
      telephonePays: user.telephonePays || '',
    });
  } catch (err) {
    next(err);
  }
});

// Solde + historique des transactions de crédits (achat de packs réservé aux
// abonnés — jamais en essai gratuit, voir A.11).
usersRouter.get('/me/credits', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const transactions = await CreditTransaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      balance: user.creditsBalance,
      // Alias ajouté : le frontend (app/credits/page.tsx) lit `creditsBalance`,
      // pas `balance` — sans ce champ, le solde affiché en haut de page
      // restait bloqué sur sa valeur au premier chargement, malgré un débit
      // backend qui fonctionnait correctement (voir aussi lib/auth-context.tsx
      // corrigé côté frontend pour rafraîchir le solde après chaque action).
      creditsBalance: user.creditsBalance,
      plan: user.plan,
      canPurchase: user.plan !== 'trial',
      transactions,
    });
  } catch (err) {
    next(err);
  }
});


/**
 * Réglages d'encaissement des paiements sur les sites clients.
 * - lien_personnel : le client fournit son lien (recommandé : page Chariow)
 * - nexai : encaissement via NexAI puis reversement (Mobile Money ou crypto)
 *   (implémentation interne non exposée au client)
 */
usersRouter.patch('/me/payments', requireAuth, async (req, res, next) => {
  try {
    
    const body = z
      .object({
        defaultPaymentMode: z.enum(['lien_personnel', 'nexai']),
        personalPaymentLink: z.string().url().optional().or(z.literal('')),
        personalPaymentProvider: z.enum(['chariow', 'maketou', 'stripe', 'autre']).optional(),
        compteReversement: z
          .object({
            type: z.enum(['mobile_money', 'crypto']),
            operateur: z.string().optional(),
            numero: z.string().optional(),
            cryptoAddress: z.string().optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    if (body.defaultPaymentMode === 'lien_personnel') {
      const link = (body.personalPaymentLink || '').trim();
      if (!link) {
        throw new AppError(
          'Indiquez le lien de votre page de paiement (ex. votre page Chariow).',
          400
        );
      }
      user.defaultPaymentMode = 'lien_personnel';
      user.personalPaymentLink = link;
      user.personalPaymentProvider = body.personalPaymentProvider;
    } else {
      const rev = body.compteReversement;
      if (!rev) {
        throw new AppError('Renseignez vos coordonnées de reversement (Mobile Money ou crypto).', 400);
      }
      if (rev.type === 'mobile_money') {
        if (!rev.operateur?.trim() || !rev.numero?.trim()) {
          throw new AppError('Opérateur et numéro Mobile Money requis.', 400);
        }
      }
      if (rev.type === 'crypto') {
        if (!rev.cryptoAddress?.trim()) {
          throw new AppError('Adresse crypto requise.', 400);
        }
      }
      user.defaultPaymentMode = 'nexai';
      user.compteReversement = {
        type: rev.type,
        operateur: rev.operateur?.trim(),
        numero: rev.numero?.trim(),
        cryptoAddress: rev.cryptoAddress?.trim(),
      };
    }

    await user.save();

    res.json({
      ok: true,
      defaultPaymentMode: user.defaultPaymentMode,
      personalPaymentLink: user.personalPaymentLink || '',
      personalPaymentProvider: user.personalPaymentProvider || '',
      compteReversement: user.compteReversement || null,
      // Mapping interne site.paymentMode : nexai → chariow (non exposé)
      sitePaymentMode: user.defaultPaymentMode === 'nexai' ? 'chariow' : 'lien_personnel',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /me/preferences — apparence de l'interface et informations de
 * facturation. Le thème clair ne concerne QUE les pages internes de l'app :
 * l'accueil public, la connexion et l'inscription restent toujours sombres
 * (identité de marque, voir Architecture v6 section 20).
 */
usersRouter.patch('/me/preferences', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        themePreference: z.enum(['sombre', 'clair']).optional(),
        entrepriseNom: z.string().max(120).optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    if (body.themePreference) user.themePreference = body.themePreference;
    if (body.entrepriseNom !== undefined) user.entrepriseNom = body.entrepriseNom.trim();
    await user.save();

    res.json({
      themePreference: user.themePreference,
      entrepriseNom: user.entrepriseNom || '',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /langue — change la langue d'interface du compte.
 *
 * Volontairement séparé de /me : c'est une préférence que le client modifie
 * seul depuis Paramètres, sans toucher au reste de son profil. Le pays reste
 * indépendant (on peut vivre en France et vouloir l'interface en anglais).
 */
usersRouter.patch('/langue', requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        langue: z.enum(['fr', 'en', 'es', 'pt', 'ar']),
      })
      .parse(req.body);

    const user = await User.findByIdAndUpdate(
      req.auth!.userId,
      { $set: { langue: body.langue } },
      { new: true }
    ).select('langue');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    res.json({ ok: true, langue: user.langue });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /pays — change le pays du compte.
 *
 * Ne modifie PAS la langue déjà choisie : une fois que le client a une langue,
 * changer de pays ne doit pas la réécrire derrière son dos.
 */
usersRouter.patch('/pays', requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ pays: z.string().length(2) }).parse(req.body);
    const code = body.pays.toUpperCase();
    if (!isPaysSupporte(code)) {
      throw new AppError("Ce pays n'est pas encore pris en charge.", 400);
    }

    const user = await User.findByIdAndUpdate(
      req.auth!.userId,
      { $set: { telephonePays: code } },
      { new: true }
    ).select('telephonePays');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    res.json({ ok: true, pays: user.telephonePays });
  } catch (err) {
    next(err);
  }
});

/** GET /langues — langues proposées par l'interface. */
usersRouter.get('/langues', requireAuth, async (_req, res) => {
  res.json({ langues: LANGUES_SUPPORTEES });
});
