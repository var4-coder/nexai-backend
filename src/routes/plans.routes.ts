import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import { PLAN_CREDITS, PLAN_DOMAIN_QUOTA, PLAN_LOGO_QUOTA } from '@/services/credits.service';
import { ChariowService } from '@/services/chariow.service';
import { getReferralStats } from '@/services/referral.service';
import { generateRecuPdf, buildNumeroRecu } from '@/services/recu.service';

export const plansRouter = Router();

/**
 * Module Abonnements (Architecture v6, section 7).
 *
 * Règle de sécurité centrale : le changement de plan n'est JAMAIS appliqué
 * au clic — uniquement à la confirmation réelle du paiement par le webhook
 * Chariow (voir chariow.service.ts, cas 'plan_purchase'). Cette route se
 * contente de générer le lien de paiement.
 */

/** Catalogue des plans, avec ce que chacun débloque réellement. */
const PLANS = [
  {
    id: 'starter',
    nom: 'Starter',
    prixFcfa: 5000,
    prixUsd: 9,
    inclus: [
      'Académie complète',
      'Boutique NexAI',
      'Trouver un business (coach IA)',
    ],
    // La génération Vidéo IA est réservée à Créateur+ et au-delà : Starter
    // reste un abonnement de formation. Il peut ouvrir l'écran Vidéo IA et
    // composer un brief, mais pas lancer de génération (voir
    // VIDEO_AD_ALLOWED_PLANS dans credits.service.ts).
    nonInclus: [
      'Créer un site',
      'Créer un logo',
      'Générer une vidéo IA',
      'Espace Agence',
    ],
  },
  {
    id: 'createur',
    nom: 'Créateur+',
    prixFcfa: 10000,
    prixUsd: 17,
    inclus: [
      'Tout Starter',
      'Créer un site (Normale et Premium)',
      'Créer un logo',
      'Générer des vidéos IA (pub voix off + avatar)',
      'Sous-domaine NexAI gratuit et illimité',
      'Achat de domaine en crédits',
      'Méthode de retrait (Compte NexAI)',
    ],
    nonInclus: ['Espace Agence', 'Mini-film / série', 'Domaine inclus'],
  },
  {
    id: 'agence',
    nom: 'Agence',
    prixFcfa: 25000,
    prixUsd: 43,
    inclus: [
      'Tout Créateur+',
      'Espace Agence (jusqu\u2019à 10 clients)',
      'Factures et reçus téléchargeables',
      '2 logos inclus',
      '1 domaine personnalisé inclus',
    ],
    nonInclus: ['Mini-film / série'],
  },
  {
    id: 'pro_max',
    nom: 'Pro Max',
    prixFcfa: 35000,
    prixUsd: 60,
    inclus: [
      'Tout Agence',
      'Mini-film / série IA (120s)',
      'Espace Agence — clients illimités',
      '3 logos inclus',
      '2 domaines personnalisés inclus',
      'Factures et reçus téléchargeables',
    ],
    nonInclus: [],
    populaire: true,
  },
] as const;

/** GET / — catalogue public des abonnements + plan actuel du client. */
plansRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan creditsBalance role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    res.json({
      planActuel: user.plan,
      // Compte admin : crédits illimités, jamais un chiffre (Architecture v6, section 18)
      creditsBalance: user.role === 'admin' ? null : user.creditsBalance,
      creditsIllimites: user.role === 'admin',
      plans: PLANS.map((p) => ({
        ...p,
        creditsParMois: PLAN_CREDITS[p.id] ?? 0,
        domainesInclus: PLAN_DOMAIN_QUOTA[p.id] ?? 0,
        logosInclus: PLAN_LOGO_QUOTA[p.id] ?? 0,
        actuel: user.plan === p.id,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /acheter — génère le lien de paiement Chariow pour un abonnement.
 * N'applique AUCUN changement de plan : c'est le webhook qui le fera, une
 * fois le paiement réellement confirmé.
 */
plansRouter.post('/acheter', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        plan: z.enum(['starter', 'createur', 'agence', 'pro_max']),
        prenom: z.string().optional(),
        nom: z.string().optional(),
        telephone: z.string().optional(),
        telephonePays: z.string().optional(),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.userId).select(
      'email plan prenom nom telephone telephonePays'
    );
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    if (user.plan === body.plan) {
      throw new AppError('Vous êtes déjà abonné à cette formule.', 400);
    }

    const plan = PLANS.find((p) => p.id === body.plan);
    if (!plan) throw new AppError('Formule inconnue.', 400);

    if (body.prenom) user.prenom = body.prenom;
    if (body.nom) user.nom = body.nom;
    if (body.telephone) user.telephone = body.telephone.replace(/\D/g, '');
    if (body.telephonePays) user.telephonePays = body.telephonePays.toUpperCase();
    await user.save();

    const paymentLink = await ChariowService.createPaymentLink({
      amount: plan.prixFcfa,
      currency: 'XOF',
      description: `Abonnement NexAI ${plan.nom}`,
      customerEmail: user.email,
      customerFirstName: user.prenom,
      customerLastName: user.nom,
      customerPhone: user.telephone,
      customerPhoneCountry: user.telephonePays,
      productKey: plan.id,
      metadata: {
        type: 'plan_purchase',
        // Identifiant de traçabilité de cette tentative d'achat (le webhook
        // le renvoie, ce qui permet de relier paiement ↔ demande initiale).
        transactionId: `plan_${plan.id}_${String(user._id)}_${Date.now()}`,
        userId: String(user._id),
        plan: plan.id,
        montantFcfa: String(plan.prixFcfa),
      },
    });

    if (!paymentLink) {
      throw new AppError('Impossible de générer le lien de paiement. Réessayez.', 502);
    }

    res.json({
      paymentLink,
      plan: plan.id,
      montantFcfa: plan.prixFcfa,
      // Rappel explicite pour le frontend : ne jamais afficher "abonnement
      // actif" avant le retour du webhook.
      note: "Votre abonnement sera activé dès la confirmation du paiement.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /parrainage — code personnel + statistiques du client
 * (Architecture v6, section 16).
 */
plansRouter.get('/parrainage', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await getReferralStats(req.auth!.userId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════
// REÇUS DE PAIEMENT (Architecture v6, section 17)
// Réservé aux plans Agence et Pro Max. Reçu simple (justificatif de
// dépense), jamais une facture réglementaire.
// ══════════════════════════════════════════════════════════════════

/** Plans ayant droit aux reçus téléchargeables. */
const PLANS_AVEC_RECU = new Set(['agence', 'pro_max']);

function assertRecuAllowed(plan: string, role?: string) {
  // Le compte admin accède à tout, sans restriction (section 18).
  if (role === 'admin') return;
  if (!PLANS_AVEC_RECU.has(plan)) {
    throw new AppError(
      'Les reçus téléchargeables sont disponibles avec les abonnements Agence et Pro Max.',
      403
    );
  }
}

/** GET /recus — liste des paiements donnant droit à un reçu. */
plansRouter.get('/recus', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    assertRecuAllowed(user.plan, user.role);

    const { CreditTransaction } = await import('@/models/CreditTransaction');
    const paiements = await CreditTransaction.find({
      userId: user._id,
      type: { $in: ['achat_abonnement', 'achat_pack'] },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({
      recus: paiements.map((p) => ({
        id: String(p._id),
        date: p.createdAt,
        libelle: p.note ?? 'Paiement NexAI',
        montantFcfa: p.montantFcfa ?? null,
        numero: buildNumeroRecu(String(p._id), p.createdAt),
        // Un reçu n'a de sens que si le montant réel est connu — les
        // anciennes transactions antérieures à cette fonctionnalité ne le
        // sont pas, on le signale plutôt que d'éditer un reçu à 0 FCFA.
        telechargeable: typeof p.montantFcfa === 'number' && p.montantFcfa > 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /recus/:transactionId — télécharge le PDF du reçu. */
plansRouter.get(
  '/recus/:transactionId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.auth!.userId).select('plan role email entrepriseNom');
      if (!user) throw new AppError('Utilisateur introuvable', 404);
      assertRecuAllowed(user.plan, user.role);

      const { CreditTransaction } = await import('@/models/CreditTransaction');
      const tx = await CreditTransaction.findOne({
        _id: req.params.transactionId,
        userId: user._id, // jamais le reçu d'un autre client
      }).lean();

      if (!tx) throw new AppError('Paiement introuvable.', 404);
      if (typeof tx.montantFcfa !== 'number' || tx.montantFcfa <= 0) {
        throw new AppError(
          "Ce paiement ne contient pas de montant exploitable pour générer un reçu.",
          400
        );
      }

      const pdfBytes = await generateRecuPdf({
        numero: buildNumeroRecu(String(tx._id), tx.createdAt),
        date: tx.createdAt,
        clientEmail: user.email,
        clientEntreprise: (user as unknown as { entrepriseNom?: string }).entrepriseNom,
        libelle: tx.note ?? 'Paiement NexAI',
        montantFcfa: tx.montantFcfa,
        referencePaiement: tx.referencePaiement,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="recu-nexai-${buildNumeroRecu(String(tx._id), tx.createdAt)}.pdf"`
      );
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      next(err);
    }
  }
);
