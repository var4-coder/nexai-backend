import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth';
import { BoutiquePack } from '@/models/BoutiquePack';
import { BoutiqueProduct } from '@/models/BoutiqueProduct';
import { Purchase } from '@/models/Purchase';
import { User, UserPlan } from '@/models/User';
import { debitCredits } from '@/services/credits.service';
import { getSignedDownloadUrl } from '@/services/cloudinary.service';
import { AppError } from '@/middleware/errorHandler';

export const boutiqueRouter = Router();

/** Catalogue visible selon le plan */
function audienceFilter(plan: UserPlan): Record<string, unknown> {
  if (plan === 'trial') {
    // Essai : voit le catalogue formation (teaser), tout verrouillé à l'achat
    return { audience: { $in: ['starter_formation', 'everyone'] } };
  }
  if (plan === 'starter') {
    // Starter = apprendre + lancer un business uniquement
    return { audience: { $in: ['starter_formation', 'everyone'] } };
  }
  // Créateur / Agence / Pro Max = toute la boutique
  return {};
}

boutiqueRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const products = await BoutiqueProduct.find({ ...audienceFilter(user.plan), status: 'publié' }).sort({
      createdAt: -1,
    });
    const purchases = await Purchase.find({ userId: req.auth!.userId }).select('productId');
    const unlockedIds = new Set(purchases.map((p) => String(p.productId)));

    const list = products.map((p) => {
      const includedInPlan =
        user.plan !== 'trial' && (p.isFreeForSubscriber || unlockedIds.has(String(p._id)));
      return {
        id: p._id,
        title: p.title,
        description: p.description,
        imageUrl: p.imageUrl,
        audience: (p as { audience?: string }).audience,
        isFreeForSubscriber: p.isFreeForSubscriber,
        creditsCost: p.creditsCost,
        priceCredits: p.creditsCost, // alias frontend
        type: (p as { audience?: string }).audience || 'product',
        fileType: p.type,
        locked: !includedInPlan,
      };
    });

    res.json({ products: list, plan: user.plan });
  } catch (err) {
    next(err);
  }
});

/**
 * Handler partagé debloquer / purchase (alias frontend).
 */
async function handleDebloquer(req: Request, res: Response, next: NextFunction) {

  try {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial') {
      throw new AppError('Boutique verrouillée en essai 7 jours — passez à un abonnement', 403);
    }

    const product = await BoutiqueProduct.findById(req.params.id);
    if (!product) throw new AppError('Produit introuvable', 404);

    // Starter ne peut débloquer que formation / business
    const aud = (product as { audience?: string }).audience || 'all_paid';
    if (user.plan === 'starter' && aud === 'all_paid') {
      throw new AppError('Ce produit est réservé aux plans Créateur, Agence et Pro Max', 403);
    }

    let purchase = await Purchase.findOne({
      userId: user._id,
      productId: product._id,
    });

    if (!purchase) {
      if (!product.isFreeForSubscriber) {
        await debitCredits(user._id, product.creditsCost, 'deblocage_boutique', {
          note: `product:${product._id}`,
        });
      }
      try {
        purchase = await Purchase.create({
          userId: user._id,
          productId: product._id,
          creditsSpent: product.isFreeForSubscriber ? 0 : product.creditsCost,
        });
      } catch (err) {
        // Double-clic / requêtes concurrentes : l'index unique (userId,
        // productId) rejette la deuxième création. On récupère l'achat déjà
        // créé par l'autre requête au lieu de renvoyer une erreur serveur —
        // le crédit n'a été débité qu'une fois grâce à l'atomicité de
        // debitCredits, donc pas de double-dépense ici non plus.
        const isDuplicateKey = (err as { code?: number }).code === 11000;
        if (!isDuplicateKey) throw err;
        purchase = await Purchase.findOne({ userId: user._id, productId: product._id });
        if (!purchase) throw err;
      }
    }

    let downloadUrl: string | null = null;
    try {
      const resourceType = 'raw' as const;
      downloadUrl = getSignedDownloadUrl(product.cloudinaryPublicId, resourceType);
    } catch {
      downloadUrl = null;
    }

    res.json({
      unlocked: true,
      purchaseId: purchase._id,
      downloadUrl,
    });
  } catch (err) {
    next(err);
  }
}

boutiqueRouter.post('/:id/debloquer', requireAuth, handleDebloquer);
/** Alias frontend : /boutique/:id/purchase */
boutiqueRouter.post('/:id/purchase', requireAuth, handleDebloquer);

/**
 * GET /packs — les packs publiés, avec le nombre de produits de chacun.
 *
 * C'est l'entrée de la Boutique : le client voit d'abord des cartes de
 * packs (comme les options de NexAI Web), puis clique pour découvrir les
 * produits du pack choisi.
 */
boutiqueRouter.get('/packs', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const packs = await BoutiquePack.find({ status: 'publié' }).sort({ ordre: 1, createdAt: 1 }).lean();

    // Comptage des produits publiés, pack par pack, en une seule agrégation.
    const compte = await BoutiqueProduct.aggregate<{ _id: unknown; total: number }>([
      { $match: { status: 'publié', packId: { $ne: null } } },
      { $group: { _id: '$packId', total: { $sum: 1 } } },
    ]);
    const parPack = new Map(compte.map((c) => [String(c._id), c.total]));

    const estEssai = user.plan === 'trial' && user.role !== 'admin';

    res.json({
      packs: packs.map((p) => ({
        id: String(p._id),
        titre: p.titre,
        sousTitre: p.sousTitre ?? null,
        description: p.description ?? null,
        creditsCost: p.creditsCost,
        gratuit: p.creditsCost === 0,
        imageUrl: p.imageUrl ?? null,
        nbProduits: parPack.get(String(p._id)) ?? 0,
        // L'essai gratuit VOIT tous les packs (règle « jamais caché »)
        // mais ne peut en ouvrir AUCUN — pas même les packs offerts, qui
        // restent réservés aux abonnés. Il découvre l'offre, il ne la
        // consomme pas.
        accessible: !estEssai,
        raisonBlocage: estEssai ? 'reserve_abonnes' : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /packs/:id/produits — les PDF contenus dans un pack. */
boutiqueRouter.get(
  '/packs/:id/produits',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findById(req.auth!.userId).select('plan role');
      if (!user) throw new AppError('Utilisateur introuvable', 404);

      const pack = await BoutiquePack.findOne({ _id: req.params.id, status: 'publié' });
      if (!pack) throw new AppError('Pack introuvable.', 404);

      // Verrou serveur : un compte d'essai ne peut ouvrir aucun pack,
      // gratuit compris. Sans ce contrôle, un appel API direct
      // contournerait le verrouillage de l'interface.
      if (user.plan === 'trial' && user.role !== 'admin') {
        throw new AppError(
          "Les packs de la Boutique sont réservés aux abonnements payants. Passez à un abonnement pour débloquer leurs contenus.",
          403
        );
      }

      const produits = await BoutiqueProduct.find({
        packId: pack._id,
        status: 'publié',
        ...audienceFilter(user.plan),
      })
        .sort({ createdAt: -1 })
        .lean();

      const achats = await Purchase.find({ userId: req.auth!.userId }).select('productId');
      const debloques = new Set(achats.map((p) => String(p.productId)));

      res.json({
        pack: {
          id: String(pack._id),
          titre: pack.titre,
          sousTitre: pack.sousTitre ?? null,
          creditsCost: pack.creditsCost,
        },
        produits: produits.map((p) => ({
          id: String(p._id),
          title: p.title,
          description: p.description ?? null,
          imageUrl: p.imageUrl ?? null,
          creditsCost: p.creditsCost,
          isFreeForSubscriber: p.isFreeForSubscriber,
          unlocked: debloques.has(String(p._id)),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);
