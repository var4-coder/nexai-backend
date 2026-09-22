import { Schema, model, Types } from 'mongoose';

/**
 * Alertes qualité génération — Architecture v6, section 18.
 *
 * Deux cas distincts, volontairement dans la même file pour que l'admin ait
 * une vue unique :
 *
 *  - ESSAI GRATUIT (`information`) : le site a déjà été livré au client
 *    (règle « jamais 0 aperçu »). Aucune action requise — sert uniquement à
 *    repérer qu'une niche produit trop souvent un mauvais résultat.
 *
 *  - PAYANT (`attente_action`) : le site n'est PAS livré tant que l'admin
 *    n'a pas tranché. Deux boutons :
 *      · Valider → le client reçoit le site tel quel
 *      · Refuser → relance complète de la génération depuis le Codeur
 */
export type AlerteType = 'information' | 'attente_action';
export type AlerteStatut = 'ouverte' | 'validee' | 'refusee' | 'traitee_auto';

export interface IAlerteQualite {
  _id: Types.ObjectId;
  siteId: Types.ObjectId;
  userId: Types.ObjectId;
  type: AlerteType;
  statut: AlerteStatut;
  /**
   * Le site a échoué MÊME après la refabrication unique de Fable. Il est
   * livré tel quel au client, qui peut ensuite l'améliorer lui-même, et
   * l'alerte est close dès sa création : elle sert d'historique et informe
   * l'administrateur. Avec le contrôle de clarté en amont, ce cas signale
   * un vrai problème du système plutôt qu'une demande floue — c'est ce que
   * l'administrateur doit examiner.
   */
  escaladeAdmin?: boolean;
  niche: string;
  plan: string;
  /**
   * Verdict motivé des juges — c'est LA raison de l'alerte. Le score n'est
   * jamais le déclencheur (il reste informatif, voir `score`).
   */
  verdictJuges?: {
    juge: 'code' | 'visuel';
    verdict: 'PASS' | 'FAIL';
    raisons?: string[];
    conseils?: string[];
  }[];
  /** Score calculé, conservé à titre informatif uniquement (suivi par niche). */
  score?: number;
  /** Qui a traité l'alerte : admin, Fable, ou le système (cas essai auto). */
  traitePar?: 'admin' | 'fable' | 'systeme';
  traiteA?: Date;
  /** Renseigné si "Refuser" a déclenché une relance : identifiant du nouveau job. */
  relanceJobId?: string;
  /**
   * Nombre d'échecs TECHNIQUES de l'appel à Fable (API indisponible, quota,
   * réponse illisible). Au-delà de MAX_ECHECS_FABLE, le site est livré sans
   * attendre : une panne d'API ne doit jamais faire patienter un client payant.
   */
  echecsFable?: number;
  createdAt: Date;
  updatedAt: Date;
}

const alerteQualiteSchema = new Schema<IAlerteQualite>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['information', 'attente_action'], required: true, index: true },
    statut: {
      type: String,
      enum: ['ouverte', 'validee', 'refusee', 'traitee_auto'],
      default: 'ouverte',
      index: true,
    },
    escaladeAdmin: { type: Boolean, default: false, index: true },
    niche: { type: String, required: true, index: true },
    plan: { type: String, required: true },
    verdictJuges: [
      {
        juge: { type: String, enum: ['code', 'visuel'] },
        verdict: { type: String, enum: ['PASS', 'FAIL'] },
        raisons: [{ type: String }],
        conseils: [{ type: String }],
        _id: false,
      },
    ],
    score: { type: Number },
    traitePar: { type: String, enum: ['admin', 'fable', 'systeme'] },
    traiteA: { type: Date },
    relanceJobId: { type: String },
    echecsFable: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// File admin : les alertes en attente d'action d'abord, puis par date.
alerteQualiteSchema.index({ statut: 1, type: 1, createdAt: -1 });
// Suivi qualité par niche (repérer une niche qui produit du mauvais en série).
alerteQualiteSchema.index({ niche: 1, createdAt: -1 });

export const AlerteQualite = model<IAlerteQualite>('AlerteQualite', alerteQualiteSchema);
