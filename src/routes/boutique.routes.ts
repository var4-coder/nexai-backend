import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth';
import { BoutiquePack } from '@/models/BoutiquePack';
import { BoutiqueProduct } from '@/models/BoutiqueProduct';
import { Purchase } from '@/models/Purchase';
import { PackPurchase } from '@/models/PackPurchase';
import type { IBoutiqueProduct } from '@/models/BoutiqueProduct';
import { z } from 'zod';
import { User, UserPlan } from '@/models/User';
import { debitCredits } from '@/services/credits.service';
import { getSignedDownloadUrl } from '@/services/cloudinary.service';
import { AppError } from '@/middleware/errorHandler';

export const boutiqueRouter = Router();

/**
 * Règle d'accès (décision du 03/10/2026) : tout contenu PAYANT se débloque
 * d'abord, avant d'entrer et d'en voir le contenu — pack, skill ou produit
 * digital. Sans prix (0 crédit), le contenu est visible gratuitement.
 *  · Pack payant débloqué → tous ses produits sont ouverts.
 *  · Pack gratuit → chaque produit payant se débloque à l'unité.
 *  · « Gratuit pour les abonnés » reste valable hors essai.
 */
function produitOuvert(
  p: Pick<IBoutiqueProduct, '_id' | 'creditsCost' | 'isFreeForSubscriber' | 'packId'>,
  ctx: { plan: UserPlan; role?: string; achats: Set<string>; packsDebloques: Set<string> }
): boolean {
  if (ctx.role === 'admin') return true;
  if (p.packId && ctx.packsDebloques.has(String(p.packId))) return true;
  if ((p.creditsCost ?? 0) === 0) return true;
  if (ctx.plan !== 'trial' && p.isFreeForSubscriber) return true;
  return ctx.achats.has(String(p._id));
}

async function contexteAcces(userId: string, plan: UserPlan, role?: string) {
  const [achats, packs, packsGratuits] = await Promise.all([
    Purchase.find({ userId }).select('productId').lean(),
    PackPurchase.find({ userId }).select('packId').lean(),
    BoutiquePack.find({ creditsCost: 0 }).select('_id').lean(),
  ]);
  return {
    plan,
    role,
    achats: new Set(achats.map((a) => String(a.productId))),
    // Pack gratuit = « débloqué » pour l'entrée, mais ses produits payants restent à l'unité.
    packsDebloques: new Set(packs.map((a) => String(a.packId))),
    packsGratuits: new Set(packsGratuits.map((x) => String(x._id))),
  };
}

/** Fichiers d'un produit (anciens produits : un seul fichier principal). */
function fichiersDe(p: IBoutiqueProduct) {
  if (p.fichiers && p.fichiers.length > 0) return p.fichiers;
  return [
    {
      nom: `${p.title}.${p.type === 'archive' ? 'zip' : 'pdf'}`,
      publicId: p.cloudinaryPublicId,
      resourceType: 'raw' as const,
      role: (p.type === 'archive' ? 'zip' : 'pdf') as 'zip' | 'pdf',
    },
  ];
}

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
  // Créateur+ / Agence / Pro Max = toute la boutique
  return {};
}

boutiqueRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);

    const products = await BoutiqueProduct.find({ ...audienceFilter(user.plan), status: 'publié' }).sort({
      createdAt: -1,
    });
    const ctx = await contexteAcces(req.auth!.userId, user.plan, (user as { role?: string }).role);

    const list = products.map((p) => {
      const includedInPlan = user.plan !== 'trial' && produitOuvert(p, ctx);
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
        categorie: p.categorie ?? 'digital',
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
      throw new AppError('Ce produit est réservé aux plans Créateur+, Agence et Pro Max', 403);
    }

    let purchase = await Purchase.findOne({
      userId: user._id,
      productId: product._id,
    });

    // Produit d'un pack payant : il faut d'abord débloquer le pack.
    if (product.packId) {
      const pack = await BoutiquePack.findById(product.packId).select('creditsCost').lean();
      if (pack && pack.creditsCost > 0 && user.role !== 'admin') {
        const packAchete = await PackPurchase.exists({ userId: user._id, packId: pack._id });
        if (!packAchete) throw new AppError('Débloquez d’abord le pack qui contient ce produit.', 403);
      }
    }
    const ctx = await contexteAcces(String(user._id), user.plan, user.role);
    const dejaOuvert = produitOuvert(product, ctx);

    if (!purchase) {
      const cout = dejaOuvert ? 0 : product.creditsCost;
      // L'achat est RÉSERVÉ avant le débit. L'ancien ordre (débiter puis créer)
      // faisait payer deux fois un double-clic : les deux requêtes débitaient,
      // puis la seconde création était rejetée en silence. Ici, l'index unique
      // (userId + productId) ne laisse passer qu'une requête jusqu'au débit.
      let reservePourCetteRequete = false;
      try {
        purchase = await Purchase.create({
          userId: user._id,
          productId: product._id,
          creditsSpent: cout,
        });
        reservePourCetteRequete = true;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        purchase = await Purchase.findOne({ userId: user._id, productId: product._id });
        if (!purchase) throw err;
      }
      if (reservePourCetteRequete && cout > 0) {
        try {
          await debitCredits(user._id, cout, 'deblocage_boutique', {
            note: `product:${product._id}`,
          });
        } catch (err) {
          // Solde insuffisant ou abonnement inactif : rien n'est débloqué.
          await Purchase.deleteOne({ _id: purchase._id });
          throw err;
        }
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
      categorie: product.categorie ?? 'digital',
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
    const packsAchetes = new Set(
      (await PackPurchase.find({ userId: user._id }).select('packId').lean()).map((x) => String(x.packId))
    );

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
        // Pack payant : à débloquer avant d'entrer (décision du 03/10/2026).
        debloque: p.creditsCost === 0 || user.role === 'admin' || packsAchetes.has(String(p._id)),
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

      if (pack.creditsCost > 0 && user.role !== 'admin') {
        const achete = await PackPurchase.exists({ userId: user._id, packId: pack._id });
        if (!achete) {
          throw new AppError(
            `Ce pack est payant : débloquez-le (${pack.creditsCost} crédits) pour voir son contenu.`,
            403
          );
        }
      }

      const produits = await BoutiqueProduct.find({
        packId: pack._id,
        status: 'publié',
        ...audienceFilter(user.plan),
      })
        .sort({ createdAt: -1 })
        .lean();

      const ctx = await contexteAcces(req.auth!.userId, user.plan, user.role);

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
          categorie: p.categorie ?? 'digital',
          unlocked: produitOuvert(p, ctx),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /produits-unite — produits publiés HORS pack (vendus à l'unité).
 * Sans cette liste, un produit publié depuis l'admin sans pack n'apparaissait
 * nulle part côté client.
 */
boutiqueRouter.get('/produits-unite', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    const produits = await BoutiqueProduct.find({
      status: 'publié',
      $or: [{ packId: null }, { packId: { $exists: false } }],
      ...audienceFilter(user.plan),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const ctx = await contexteAcces(req.auth!.userId, user.plan, user.role);
    res.json({
      produits: produits.map((p) => ({
        id: String(p._id),
        title: p.title,
        description: p.description ?? null,
        imageUrl: p.imageUrl ?? null,
        creditsCost: p.creditsCost,
        isFreeForSubscriber: p.isFreeForSubscriber,
        categorie: p.categorie ?? 'digital',
        unlocked: produitOuvert(p, ctx),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /packs/:id/debloquer — débloque un pack payant (débit unique). Un pack
 * débloqué ouvre tous ses produits. Un pack gratuit n'a rien à débloquer.
 */
boutiqueRouter.post('/packs/:id/debloquer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial' && user.role !== 'admin') {
      throw new AppError('Les packs de la Boutique sont réservés aux abonnements payants.', 403);
    }
    const pack = await BoutiquePack.findOne({ _id: req.params.id, status: 'publié' });
    if (!pack) throw new AppError('Pack introuvable.', 404);
    if (pack.creditsCost === 0 || user.role === 'admin') return res.json({ debloque: true, creditsSpent: 0 });

    const deja = await PackPurchase.findOne({ userId: user._id, packId: pack._id });
    if (deja) return res.json({ debloque: true, creditsSpent: 0 });

    // Réservation avant débit (voir handleDebloquer) : un double-clic ne
    // débite qu'une fois.
    let achat;
    try {
      achat = await PackPurchase.create({ userId: user._id, packId: pack._id, creditsSpent: pack.creditsCost });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      return res.json({ debloque: true, creditsSpent: 0 });
    }
    try {
      await debitCredits(user._id, pack.creditsCost, 'deblocage_boutique', { note: `pack:${pack._id}` });
    } catch (err) {
      await PackPurchase.deleteOne({ _id: achat._id });
      throw err;
    }
    res.json({ debloque: true, creditsSpent: pack.creditsCost });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /produits/:id/contenu — contenu d'un produit OUVERT : liens de
 * téléchargement signés (1 h) de chaque fichier, et pour un skill le texte
 * à copier. Refusé tant que le produit payant n'est pas débloqué.
 */
boutiqueRouter.get('/produits/:id/contenu', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    z.string().regex(/^[a-f0-9]{24}$/i).parse(req.params.id);
    const user = await User.findById(req.auth!.userId).select('plan role');
    if (!user) throw new AppError('Utilisateur introuvable', 404);
    if (user.plan === 'trial' && user.role !== 'admin') {
      throw new AppError('La Boutique est réservée aux abonnements payants.', 403);
    }
    const product = await BoutiqueProduct.findOne({ _id: req.params.id, status: 'publié' });
    if (!product) throw new AppError('Produit introuvable', 404);
    const aud = (product as { audience?: string }).audience || 'all_paid';
    if (user.plan === 'starter' && aud === 'all_paid' && user.role !== 'admin') {
      throw new AppError('Ce produit est réservé aux plans Créateur+, Agence et Pro Max', 403);
    }
    if (product.packId && user.role !== 'admin') {
      const pack = await BoutiquePack.findById(product.packId).select('creditsCost').lean();
      if (pack && pack.creditsCost > 0 && !(await PackPurchase.exists({ userId: user._id, packId: pack._id }))) {
        throw new AppError('Débloquez d’abord le pack qui contient ce produit.', 403);
      }
    }
    const ctx = await contexteAcces(String(user._id), user.plan, user.role);
    if (!produitOuvert(product, ctx)) {
      throw new AppError(`Débloquez ce produit (${product.creditsCost} crédits) pour voir son contenu.`, 403);
    }

    const categorie = product.categorie ?? 'digital';
    const fichiers = fichiersDe(product).map((f) => {
      let url: string | null = null;
      try {
        url = getSignedDownloadUrl(f.publicId, f.resourceType);
      } catch {
        url = null;
      }
      return { nom: f.nom, role: f.role, url };
    });
    res.json({
      id: String(product._id),
      title: product.title,
      categorie,
      fichiers,
      // Copier : uniquement pour un skill (décision du 03/10/2026).
      texteACopier: categorie === 'skill' ? product.texteACopier ?? null : null,
    });
  } catch (err) {
    next(err);
  }
});
