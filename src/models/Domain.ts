import { Schema, model, models, Types, Document } from 'mongoose';

/**
 * Domaine enregistré chez GoDaddy pour le compte d'un client.
 *
 * Pourquoi ce modèle existe
 * -------------------------
 * Les domaines sont achetés dans le compte GoDaddy de NexAI, pas dans celui du
 * client. Le renouvellement automatique est donc DÉSACTIVÉ à l'achat (voir
 * godaddy.service.ts → purchaseDomain) : sans ça, NexAI paierait 23 à 60 $ par
 * an et par domaine, indéfiniment, y compris pour des clients résiliés.
 *
 * À la place, le renouvellement est provisionné mois par mois sur le quota de
 * crédits du client, à partir de la 2ème année. Ce modèle porte l'état de ce
 * provisionnement.
 */

export type DomainStatus =
  /** Première année payée par l'achat initial, rien à prélever encore. */
  | 'premiere_annee'
  /** 2ème année et suivantes : prélèvement mensuel en cours. */
  | 'provisionnement'
  /** Provision complète, renouvellement à déclencher chez GoDaddy. */
  | 'pret_a_renouveler'
  /** Solde insuffisant — délai de grâce avant expiration. */
  | 'provision_interrompue'
  /** Renouvellement effectué, nouveau cycle démarré. */
  | 'renouvele'
  /** Abandonné : le domaine expire (client parti, ou refus de renouveler). */
  | 'expire';

export interface IDomain extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  siteId?: Types.ObjectId;
  /** Nom complet, ex. "mon-site.com" (minuscules). */
  domainName: string;
  /** Extension, ex. ".com". */
  tld: string;

  /** true si l'offre gratuite de l'abonnement a couvert tout ou partie de l'achat. */
  usedFreeQuota: boolean;
  /** Part du budget gratuit consommée, en USD (0 si achat intégral en crédits). */
  freeBudgetSpentUsd: number;
  /** Crédits réellement débités au client à l'achat. */
  creditsChargedAtPurchase: number;

  /** Prix de renouvellement annuel constaté, en USD. */
  renewalAnnualUsd: number;
  /** Crédits à prélever chaque mois pour couvrir ce renouvellement. */
  monthlyRenewalCredits: number;
  /** Crédits déjà provisionnés pour le cycle en cours. */
  creditsProvisioned: number;
  /** Objectif à atteindre avant renouvellement (12 × monthlyRenewalCredits). */
  creditsTarget: number;

  /** Date du dernier prélèvement mensuel réussi. */
  lastChargeAt?: Date;
  /** Date d'expiration chez GoDaddy. */
  expiresAt: Date;
  /** Date à partir de laquelle les prélèvements commencent (achat + 1 an). */
  provisioningStartsAt: Date;

  status: DomainStatus;
  /** Nombre de prélèvements échoués consécutifs (solde insuffisant). */
  failedChargeCount: number;
  /** Rappels d'expiration déjà envoyés, en jours restants (60, 30, 7). */
  remindersSent: number[];

  createdAt: Date;
  updatedAt: Date;
}

const domainSchema = new Schema<IDomain>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', index: true },
    domainName: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tld: { type: String, required: true, lowercase: true },

    usedFreeQuota: { type: Boolean, default: false },
    freeBudgetSpentUsd: { type: Number, default: 0, min: 0 },
    creditsChargedAtPurchase: { type: Number, default: 0, min: 0 },

    renewalAnnualUsd: { type: Number, required: true, min: 0 },
    monthlyRenewalCredits: { type: Number, required: true, min: 0 },
    creditsProvisioned: { type: Number, default: 0, min: 0 },
    creditsTarget: { type: Number, required: true, min: 0 },

    lastChargeAt: { type: Date },
    expiresAt: { type: Date, required: true, index: true },
    provisioningStartsAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: [
        'premiere_annee',
        'provisionnement',
        'pret_a_renouveler',
        'provision_interrompue',
        'renouvele',
        'expire',
      ],
      default: 'premiere_annee',
      index: true,
    },
    failedChargeCount: { type: Number, default: 0, min: 0 },
    remindersSent: { type: [Number], default: [] },
  },
  { timestamps: true }
);

export const Domain = models.Domain || model<IDomain>('Domain', domainSchema);
