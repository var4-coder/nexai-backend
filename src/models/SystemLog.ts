import { Schema, model, Types } from 'mongoose';

/**
 * Journal technique brut — Architecture v6, section 18.
 *
 * Distinct de "Qualité" (statistiques agrégées) et de "Alertes" (décisions à
 * prendre) : c'est l'historique chronologique de TOUT ce qui se passe sur la
 * plateforme, pour retracer une séquence d'événements en cas de problème.
 *
 * Chaque événement est aussi envoyé par email à l'administrateur (voir
 * logs.service.ts) — d'où la formule retenue avec le porteur de projet :
 * « la base de données complète des actions NexAI, tout est traçable ».
 */
export type LogCategorie =
  | 'deploiement'
  | 'paiement'
  | 'alerte_qualite'
  | 'prompt'
  | 'action_admin'
  | 'ia'
  | 'systeme';

export type LogNiveau = 'info' | 'warn' | 'error';

export interface ISystemLog {
  _id: Types.ObjectId;
  categorie: LogCategorie;
  niveau: LogNiveau;
  /** Résumé court, lisible tel quel dans la liste admin */
  message: string;
  /** Contexte libre (identifiants, scores, montants…) — jamais de secret */
  contexte?: Record<string, unknown>;
  userId?: Types.ObjectId;
  siteId?: Types.ObjectId;
  /** true une fois l'événement expédié par email à l'admin */
  emailEnvoye?: boolean;
  createdAt: Date;
}

const systemLogSchema = new Schema<ISystemLog>(
  {
    categorie: {
      type: String,
      enum: ['deploiement', 'paiement', 'alerte_qualite', 'prompt', 'action_admin', 'ia', 'systeme'],
      required: true,
      index: true,
    },
    niveau: { type: String, enum: ['info', 'warn', 'error'], default: 'info', index: true },
    message: { type: String, required: true },
    contexte: { type: Schema.Types.Mixed },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', index: true },
    emailEnvoye: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Liste admin : du plus récent au plus ancien, filtrable par catégorie.
systemLogSchema.index({ createdAt: -1 });
systemLogSchema.index({ categorie: 1, createdAt: -1 });

export const SystemLog = model<ISystemLog>('SystemLog', systemLogSchema);
