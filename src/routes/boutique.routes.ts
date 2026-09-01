import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth';
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

    const products = await BoutiqueProduct.find(audienceFilter(user.plan)).sort({ createdAt: -1 });
    const purchases = await Purchase.find({ userId: req.auth!.userId }).select('productId');
    const unlockedIds = new Set(purchases.map((p) => String(p.productId)));

    const list = products.map((p) => {
      const includedInPlan =
        user.plan !== 'trial' && (p.isFreeForSubscriber || unlockedIds.has(String(p._id)));
      return {
        id: p._id,
        title: p.title,
        description: p.description,
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
      const resourceType = product.type === 'video' ? 'video' : product.type === 'image' ? 'image' : 'raw';
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
