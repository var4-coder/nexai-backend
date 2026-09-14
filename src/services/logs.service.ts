import { Types } from 'mongoose';
import { SystemLog, LogCategorie, LogNiveau } from '@/models/SystemLog';
import { env } from '@/config/env';

/**
 * Journal système — Architecture v6, section 18 (Logs).
 *
 * Chaque événement est enregistré en base ET expédié par email à
 * l'administrateur. Formulation retenue avec le porteur de projet :
 * « la base de données complète des actions NexAI — tout est traçable en
 * cas de problème ».
 *
 * Règle absolue : journaliser ne doit JAMAIS faire échouer l'opération
 * métier en cours. Toute erreur ici est avalée et signalée en console.
 */

export interface LogEventParams {
  categorie: LogCategorie;
  niveau?: LogNiveau;
  message: string;
  contexte?: Record<string, unknown>;
  userId?: Types.ObjectId | string;
  siteId?: Types.ObjectId | string;
}

/**
 * Niveaux expédiés par email. Les 'info' sont consultables dans l'admin
 * mais n'encombrent pas la boîte mail — seuls les avertissements et les
 * erreurs déclenchent une notification, pour que l'email reste un signal
 * utile plutôt qu'un flux ignoré.
 */
const NIVEAUX_EMAIL: ReadonlySet<LogNiveau> = new Set(['warn', 'error']);

export async function logEvent(params: LogEventParams): Promise<void> {
  const niveau = params.niveau ?? 'info';
  try {
    const entry = await SystemLog.create({
      categorie: params.categorie,
      niveau,
      message: params.message,
      contexte: params.contexte,
      userId: params.userId,
      siteId: params.siteId,
      emailEnvoye: false,
    });

    if (NIVEAUX_EMAIL.has(niveau) && env.ADMIN_EMAIL) {
      try {
        const { sendAdminLogEmail } = await import('@/services/brevo.service');
        await sendAdminLogEmail({
          to: env.ADMIN_EMAIL,
          categorie: params.categorie,
          niveau,
          message: params.message,
          contexte: params.contexte,
          date: entry.createdAt,
        });
        entry.emailEnvoye = true;
        await entry.save();
      } catch (mailErr) {
        // L'entrée reste en base même si l'email échoue — elle sera
        // visible dans l'admin, simplement non notifiée.
        console.error('[logs] Envoi email admin échoué (non bloquant) :', mailErr);
      }
    }
  } catch (err) {
    console.error('[logs] Journalisation échouée (non bloquant) :', err);
  }
}
