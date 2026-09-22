import { Schema, model, Types } from 'mongoose';

/**
 * Versions de prompts système — Architecture v6, section 18 (Prompts).
 *
 * Chaque modification garde une trace complète, ce qui permet de revenir à
 * une version antérieure en un clic, même après validation.
 *
 * Cycle de vie :
 *   'actif'    — la version actuellement utilisée en production
 *   'candidat' — proposition de Sonnet 5, en attente de la décision admin
 *   'archive'  — ancienne version remplacée (restaurable à tout moment)
 *   'rejete'   — candidat refusé par l'admin
 *
 * Règle de déclenchement : Fable DÉTECTE le point faible (niche, rôle
 * précis, ou problème systémique), Sonnet 5 RÉDIGE la correction pour ces
 * parties uniquement — jamais une réécriture globale. L'admin valide ou
 * refuse ; son silence pendant 1h vaut acceptation (voir appliedAt/expiresAt).
 */
export type PromptStatut = 'actif' | 'candidat' | 'archive' | 'rejete';

/** Postes dont le prompt système peut être corrigé automatiquement. */
export type PromptCible =
  | 'codeur_normale'
  | 'codeur_normale_apercu2'
  | 'codeur_premium'
  | 'juge_code'
  | 'juge_visuel'
  | 'chat_creation'
  | 'support_client'
  | 'video_script';

export interface IPromptVersion {
  _id: Types.ObjectId;
  cible: PromptCible;
  /** Niche concernée si le diagnostic est ciblé, sinon null = systémique */
  niche?: string | null;
  statut: PromptStatut;
  /** Numéro de version incrémental par cible (v1, v2, v3…) */
  version: number;
  contenu: string;

  // ── Uniquement pour les candidats proposés automatiquement ────
  /** Diagnostic de Fable : où se situe la faille et pourquoi */
  raisonDiagnostic?: string;
  /** Effet attendu, formulé par Sonnet lors de la proposition */
  effetAttendu?: string;
  /** Valeur du seuil négatif NexAI au moment du déclenchement */
  seuilNegatifDeclencheur?: number;
  /** Version remplacée par ce candidat (pour restauration) */
  remplaceVersionId?: Types.ObjectId;
  /**
   * Date limite du silence admin. Passé ce délai (1h), Fable applique
   * automatiquement — un refus explicite de l'admin l'emporte toujours.
   */
  autoApplyAt?: Date;

  // ── Traçabilité de la décision ────────────────────────────────
  decidePar?: string; // email admin, ou 'auto' si appliqué par silence
  decideAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const promptVersionSchema = new Schema<IPromptVersion>(
  {
    cible: { type: String, required: true, index: true },
    niche: { type: String, default: null },
    statut: {
      type: String,
      enum: ['actif', 'candidat', 'archive', 'rejete'],
      required: true,
      index: true,
    },
    version: { type: Number, required: true },
    contenu: { type: String, required: true },

    raisonDiagnostic: { type: String },
    effetAttendu: { type: String },
    seuilNegatifDeclencheur: { type: Number },
    remplaceVersionId: { type: Schema.Types.ObjectId, ref: 'PromptVersion' },
    autoApplyAt: { type: Date },

    decidePar: { type: String },
    decideAt: { type: Date },
  },
  { timestamps: true }
);

// Un seul prompt actif par couple (cible, niche) — garde-fou contre deux
// versions actives simultanées qui rendraient le comportement imprévisible.
promptVersionSchema.index(
  { cible: 1, niche: 1, statut: 1 },
  { unique: true, partialFilterExpression: { statut: 'actif' } }
);

export const PromptVersion = model<IPromptVersion>('PromptVersion', promptVersionSchema);
