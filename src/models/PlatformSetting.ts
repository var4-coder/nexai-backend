import { Schema, model, models, Document } from 'mongoose';

/**
 * Réglage simple de la plateforme, une ligne par clé.
 * Sert au vendeur de domaines (GoDaddy ou Porkbun) choisi par l'admin.
 */
export interface IPlatformSetting extends Document {
  cle: string;
  valeur: string;
}

const platformSettingSchema = new Schema<IPlatformSetting>(
  {
    cle: { type: String, required: true, unique: true, index: true },
    valeur: { type: String, required: true },
  },
  { timestamps: true }
);

export const PlatformSetting =
  models.PlatformSetting || model<IPlatformSetting>('PlatformSetting', platformSettingSchema);
