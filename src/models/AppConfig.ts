import { Schema, model } from 'mongoose';

/**
 * Config applicative clé/valeur (admin).
 * Utilisé notamment pour les instructions complémentaires du chat Haiku
 * (chargées en bas du prompt système, sans jamais pouvoir contredire ANTI_RULES).
 */
export interface IAppConfig {
  key: string;
  value: string;
  updatedAt: Date;
  createdAt: Date;
}

const appConfigSchema = new Schema<IAppConfig>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, default: '' },
  },
  { timestamps: true }
);

export const AppConfig = model<IAppConfig>('AppConfig', appConfigSchema);

/** Clé pour les instructions admin du chat guide */
export const CHAT_ADMIN_INSTRUCTIONS_KEY = 'chat_admin_instructions';

/** Longueur max des instructions admin (caractères) */
export const CHAT_ADMIN_INSTRUCTIONS_MAX_LEN = 4000;
