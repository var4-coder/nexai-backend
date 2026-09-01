import { Schema, model, Types } from 'mongoose';

export type SiteNiche =
  | 'hotellerie_evenementiel'
  | 'sante_bienetre'
  | 'immobilier_architecture'
  | 'services_locaux'
  | 'business_vitrine'
  | 'ecommerce_mode'
  | 'portfolio_creatif'
  | 'tech_startup_saas'
  | 'restaurant_gastronomie'
  | 'education_formation';

export type SiteStatus =
  | 'brief_incomplete'
  | 'generating'
  | 'ready'
  | 'launched'
  | 'failed'
  | 'pending_support'
  | 'offline';

/** Qualité de génération choisie par le client (voir ia-pipeline.service.ts pour le routage des modèles) */
export type SiteQualityTier = 'normal' | 'premium';

export type DomainType = 'sous_domaine' | 'godaddy' | 'byod';
export type PaymentMode = 'lien_personnel' | 'chariow';
/** Libellé d'affichage du prestataire choisi par le client pour son lien personnel — aucune règle technique différente selon la valeur (Partie D.9). */
export type PaymentProvider = 'chariow' | 'maketou' | 'stripe' | 'autre';

/**
 * Type technique du site livré au client :
 *  - 'static'  : page(s) HTML/CSS/JS générées par le pipeline IA, déployées telles
 *                quelles sur Netlify (avec formulaires branchés sur le backend public,
 *                voir routes/public.routes.ts).
 *  - 'nextjs'  : projet Next.js scaffoldé (pages + API routes), buildé puis déployé sur
 *                Netlify — pour les sites qui ont besoin d'un vrai backend applicatif
 *                (multi-pages dynamiques, logique serveur, etc.).
 */
export type SiteType = 'static' | 'nextjs';

export interface ISiteProposalPage {
  slug: string; // 'index' | 'biens' | 'menu' | 'contact' ...
  title: string;
  description?: string;
  html: string;
}

export interface ISiteProposal {
  versionId: string; // prop_1 | prop_2 | prop_3
  seedDa: string;
  score?: number;
  htmlDemo?: string; // page d'accueil (toujours présente, comportement historique inchangé)
  /**
   * Pages additionnelles générées pour les sites multi-pages (voir
   * PAGES_PAR_NICHE / resolvePagePlan dans ia-pipeline.service.ts). Vide
   * pour les sites à page unique — comportement historique inchangé dans
   * ce cas : seul htmlDemo est utilisé.
   */
  pages?: ISiteProposalPage[];
  pagesMeta?: { slug: string; title: string; description: string }[];
  dataNexaiIds?: string[];
  ambianceImages?: string[];
  /** 'realiste' = photo Grok Imagine (+ logo) ; 'mockup' = image sourcée Pexels via Claude Sonnet 5 */
  imageStyle?: 'realiste' | 'mockup';
  imageAttribution?: string;
  /**
   * Badge "Premium" : vrai pour TOUTES les propositions issues d'une génération
   * qualité Premium (tarif 25 crédits) — indépendant du classement.
   */
  premiumBadge?: boolean;
  /**
   * Badge "Recommandé" : vrai UNIQUEMENT pour la proposition la mieux classée
   * (meilleur score) du lot retourné au client. Concept différent de Premium :
   * Premium = qualité haute choisie par le client ; Recommandé = meilleure du
   * classement parmi les propositions livrées (peut arriver sur un lot Normal
   * comme Premium, et peut coexister avec le badge Premium sur la même
   * proposition sans confusion, le client ne validant qu'un seul lot par clic).
   */
  recommandeBadge?: boolean;
}

export interface ISite {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  clientId?: Types.ObjectId; // référence à Client, uniquement pour les sites créés depuis l'Espace Agence
  niche: SiteNiche;
  /** Nom d'affichage (sinon fallback niche côté UI) */
  name?: string;
  brief: Record<string, unknown>;
  status: SiteStatus;
  /** Qualité choisie lors de la dernière génération lancée (défaut 'normal') */
  qualityTier?: SiteQualityTier;
  /** 'static' (défaut) ou 'nextjs' pour les sites complexes nécessitant un vrai backend applicatif */
  siteType?: SiteType;
  proposals: ISiteProposal[];
  chosenProposalId?: string;
  domainType?: DomainType;
  domainName?: string;
  netlifySiteId?: string;
  paymentMode?: PaymentMode;
  /** Lien de paiement réellement utilisé pour CE site (validé avant lancement — voir services/payment-link.service.ts). Vide si paymentMode='chariow' (compte NexAI). */
  paymentLink?: string;
  /** Libellé du prestataire choisi pour ce site (affichage uniquement) — reprend celui du compte si non précisé au lancement. */
  paymentProvider?: PaymentProvider;
  /** Référence vers le document SiteRuntime (Mongo) créé au lancement — voir services/site-runtime.service.ts */
  runtimeId?: string;
  /**
   * Clé publique du site, générée au lancement. Embarquée dans le HTML/JS livré au
   * client (ou dans le projet Next.js) pour authentifier les appels au backend public
   * (formulaires, réservations...). Ce n'est pas un secret critique (comparable à une
   * clé publique Stripe) : elle sert juste à rattacher une soumission au bon site et à
   * limiter le spam, pas à protéger des données sensibles.
   */
  publicApiKey?: string;
  capacites: string[]; // capacités dynamiques activées selon la niche
  logoProposals?: { versionId: string; url: string; prompt?: string }[];
  chosenLogoUrl?: string;
  embellishmentUrl?: string;
  embellishmentMode?: 'background' | 'decorative';
  createdAt: Date;
  updatedAt: Date;
}

const siteSchema = new Schema<ISite>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', index: true },
    niche: { type: String, required: true },
    name: { type: String, trim: true },
    brief: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: [
        'brief_incomplete',
        'generating',
        'ready',
        'launched',
        'failed',
        'pending_support',
        'offline',
      ],
      default: 'brief_incomplete',
    },
    qualityTier: { type: String, enum: ['normal', 'premium'], default: 'normal' },
    siteType: { type: String, enum: ['static', 'nextjs'], default: 'static' },
    proposals: [
      {
        versionId: String,
        seedDa: String,
        score: Number,
        htmlDemo: String,
        pages: [
          {
            slug: String,
            title: String,
            description: String,
            html: String,
          },
        ],
        pagesMeta: [{ slug: String, title: String, description: String }],
        dataNexaiIds: [String],
        ambianceImages: [String],
        imageStyle: { type: String, enum: ['realiste', 'mockup'] },
        imageAttribution: String,
        premiumBadge: { type: Boolean, default: false },
        recommandeBadge: { type: Boolean, default: false },
      },
    ],
    chosenProposalId: { type: String },
    domainType: { type: String, enum: ['sous_domaine', 'godaddy', 'byod'] },
    domainName: { type: String },
    netlifySiteId: { type: String },
    paymentMode: { type: String, enum: ['lien_personnel', 'chariow'] },
    paymentLink: { type: String },
    paymentProvider: { type: String, enum: ['chariow', 'maketou', 'stripe', 'autre'] },
    runtimeId: { type: String },
    publicApiKey: { type: String, index: true },
    capacites: { type: [String], default: [] },
    logoProposals: [
      {
        versionId: String,
        url: String,
        prompt: String,
      },
    ],
    chosenLogoUrl: { type: String },
    embellishmentUrl: { type: String },
    embellishmentMode: { type: String, enum: ['background', 'decorative'] },
  },
  { timestamps: true }
);

// Sérialisation JSON : id à la place de _id (contrat frontend)
siteSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: any) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

export const Site = model<ISite>('Site', siteSchema);
