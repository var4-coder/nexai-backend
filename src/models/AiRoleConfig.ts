import { Schema, model, Types } from 'mongoose';

/**
 * Panneau admin "Équipe IA" — permet à l'administrateur de basculer le
 * modèle utilisé pour un rôle IA donné, parmi une liste d'alternatives
 * COMPATIBLES avec ce poste (voir ai-role-registry.ts pour la liste des
 * rôles et de leurs alternatives autorisées). Un seul document par rôle.
 *
 * Ne PAS utiliser cette collection comme routage libre : chaque rôle limite
 * volontairement les valeurs acceptées à des modèles réellement capables de
 * tenir ce poste (ex. le Juge Visuel exige un modèle avec vision).
 */
export type AiRole =
  | 'chat_creation_site'
  | 'chat_autres_modes'
  | 'support_client'
  | 'codeur_normale'
  | 'codeur_normale_apercu2'
  | 'codeur_premium'
  | 'codeur_pages_premium'
  | 'codeur_pages_normale'
  | 'juge_code'
  | 'reparateur_code'
  | 'juge_visuel'
  | 'diagnostic_ameliorer_site'
  | 'agent_qualite_alertes'
  | 'aide_ia_essai'
  | 'aide_ia_payant'
  | 'amelioration_prompts'
  | 'titre_accroche_academy_boutique';

export interface IAiRoleConfig {
  _id: Types.ObjectId;
  role: AiRole;
  /** Identifiant de modèle actuellement actif pour ce rôle (ex: 'claude-haiku-4-5-20251001', 'grok-4.3') */
  activeModel: string;
  updatedBy?: string; // email admin
  updatedAt: Date;
  createdAt: Date;
}

const aiRoleConfigSchema = new Schema<IAiRoleConfig>(
  {
    role: { type: String, required: true, unique: true },
    activeModel: { type: String, required: true },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export const AiRoleConfig = model<IAiRoleConfig>('AiRoleConfig', aiRoleConfigSchema);
