import { Schema, model, Types } from 'mongoose';

/**
 * Incidents techniques de la plateforme NexAI elle-même — Administration
 * → Sécurité & Maintenance.
 *
 * Découpage en 3 étages, volontaire :
 *   1. DÉTECTION — le backend capture ses propres pannes (erreurs 500,
 *      jobs en échec, intégrations externes indisponibles).
 *   2. DIAGNOSTIC — Fable analyse l'erreur brute et produit une cause
 *      probable + une piste de correction. Sonnet rédige le correctif
 *      détaillé (5× moins cher que Fable pour de la rédaction).
 *      RIEN n'est modifié automatiquement.
 *   3. RÉPARATION — uniquement par l'agent externe de l'administrateur
 *      (compte Console, accès Git), et seulement pour les incidents que
 *      l'admin a explicitement approuvés.
 *
 * Le backend de production ne modifie JAMAIS son propre code : il n'a ni
 * accès Git, ni droit d'écriture sur ses sources.
 */
export type IncidentStatut =
  | 'nouveau'          // détecté, pas encore diagnostiqué
  | 'diagnostique'     // Fable a analysé, en attente de décision admin
  | 'approuve'         // l'admin autorise la réparation par son agent
  | 'refuse'           // l'admin refuse (faux positif, ou correction manuelle)
  | 'en_reparation'    // l'agent externe a pris l'incident en charge
  | 'resolu';

export type IncidentGravite = 'faible' | 'moyenne' | 'critique';

export interface IPlatformAlert {
  _id: Types.ObjectId;
  statut: IncidentStatut;
  gravite: IncidentGravite;
  /** Zone touchée : 'api', 'worker', 'integration', 'base', 'inconnu' */
  /**
   * Qui doit s'occuper de cette panne.
   *
   *  · 'fable'  — les agents savent la traiter seuls (relance, changement de
   *    modèle, nouvelle tentative). Aucune action de l'administrateur.
   *  · 'serieuse' — ni Fable ni l'agent de correction ne peuvent la régler :
   *    clé API, crédits fournisseur, panne externe, bug du code. Seul
   *    l'administrateur peut agir. Déclenche un email immédiat.
   */
  categorie: 'fable' | 'serieuse';
  composant: string;
  /** Message d'erreur brut, tel que capturé */
  erreur: string;
  /** Pile d'appel, tronquée */
  stack?: string;
  /** Route ou job concerné */
  contexte?: string;
  /**
   * Empreinte de déduplication : une erreur qui boucle ne doit créer
   * qu'un seul incident, avec un compteur — sinon l'admin reçoit des
   * centaines d'emails pour le même problème.
   */
  empreinte: string;
  occurrences: number;
  derniereOccurrence: Date;

  // ── Diagnostic (Fable + Sonnet) ──────────────────────────────
  causeProbable?: string;
  pisteCorrection?: string;
  fichiersSuspects?: string[];
  diagnostiqueA?: Date;

  // ── Décision de l'administrateur ─────────────────────────────
  decidePar?: string;
  decideA?: Date;
  /** Compte-rendu renvoyé par l'agent externe après réparation */
  compteRenduAgent?: string;
  resoluA?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const platformAlertSchema = new Schema<IPlatformAlert>(
  {
    statut: {
      type: String,
      enum: ['nouveau', 'diagnostique', 'approuve', 'refuse', 'en_reparation', 'resolu'],
      default: 'nouveau',
      index: true,
    },
    gravite: { type: String, enum: ['faible', 'moyenne', 'critique'], default: 'moyenne', index: true },
    categorie: { type: String, enum: ['fable', 'serieuse'], default: 'serieuse', index: true },
    composant: { type: String, required: true, index: true },
    erreur: { type: String, required: true },
    stack: { type: String },
    contexte: { type: String },
    empreinte: { type: String, required: true, unique: true, index: true },
    occurrences: { type: Number, default: 1 },
    derniereOccurrence: { type: Date, default: Date.now },

    causeProbable: { type: String },
    pisteCorrection: { type: String },
    fichiersSuspects: [{ type: String }],
    diagnostiqueA: { type: Date },

    decidePar: { type: String },
    decideA: { type: Date },
    compteRenduAgent: { type: String },
    resoluA: { type: Date },
  },
  { timestamps: true }
);

platformAlertSchema.index({ statut: 1, gravite: 1, derniereOccurrence: -1 });

export const PlatformAlert = model<IPlatformAlert>('PlatformAlert', platformAlertSchema);
