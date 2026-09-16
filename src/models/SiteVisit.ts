import { Schema, model, Types } from 'mongoose';

/**
 * Visites des sites clients déployés.
 *
 * Chaque page vue d'un site généré par NexAI crée une ligne ici, envoyée
 * par un petit script injecté dans le site au moment de la mise en ligne
 * (voir tracking-snippet.service.ts).
 *
 * Choix de conception :
 *  · Aucune donnée personnelle n'est stockée — ni adresse IP en clair, ni
 *    identifiant publicitaire. Le visiteur n'est pas suivi d'un site à
 *    l'autre : seule une empreinte quotidienne anonyme permet de distinguer
 *    « visiteurs » et « pages vues ».
 *  · Les lignes s'effacent automatiquement après 90 jours (index TTL), ce
 *    qui borne définitivement la taille de la collection : sans cela, un
 *    site à fort trafic ferait grossir la base indéfiniment.
 */
export interface ISiteVisit {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  /** Propriétaire du site — évite une jointure pour les statistiques client */
  userId: Types.ObjectId;
  /** Chemin consulté, ex. « / » ou « /contact » */
  chemin: string;
  /**
   * Empreinte anonyme du visiteur, renouvelée chaque jour.
   * Sert uniquement à ne pas compter dix fois la même personne.
   */
  empreinteJour: string;
  /** Domaine d'où vient le visiteur (google.com, facebook.com…), jamais l'URL complète */
  source?: string;
  /** Type d'appareil, déduit du navigateur */
  appareil: 'mobile' | 'ordinateur' | 'tablette' | 'inconnu';
  /** Code pays sur 2 lettres, quand l'hébergeur le fournit */
  pays?: string;
  createdAt: Date;
}

const siteVisitSchema = new Schema<ISiteVisit>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    chemin: { type: String, default: '/' },
    empreinteJour: { type: String, required: true },
    source: { type: String },
    appareil: {
      type: String,
      enum: ['mobile', 'ordinateur', 'tablette', 'inconnu'],
      default: 'inconnu',
    },
    pays: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Statistiques par site sur une période donnée.
siteVisitSchema.index({ siteId: 1, createdAt: -1 });
// Vue d'ensemble, tous sites confondus, pour le tableau de bord.
siteVisitSchema.index({ userId: 1, createdAt: -1 });

// Purge automatique après 90 jours : MongoDB supprime les documents
// expirés tout seul, sans tâche de maintenance à écrire.
siteVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const SiteVisit = model<ISiteVisit>('SiteVisit', siteVisitSchema);
