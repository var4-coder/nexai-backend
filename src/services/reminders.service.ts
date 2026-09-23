import { ChatSession } from '@/models/ChatSession';
import { Site } from '@/models/Site';
import { User } from '@/models/User';
import { sendCoachBusinessReminderEmail } from './brevo.service';

const REMINDER_DELAY_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Pub 4 (Partie commerciale, relance différée) — le seul mécanisme de
 * relance hors fenêtre du chat : un client Starter a trouvé une idée avec le
 * Coach business (session mode='business' confirmée) mais n'a créé aucun
 * site 48h plus tard. On lui envoie un rappel, une seule fois par session
 * (flag `reminderSent`), et seulement s'il est toujours Starter et n'a
 * toujours aucun site.
 *
 * Appelé périodiquement par le worker (voir jobs/worker.ts, queue
 * 'reminders').
 */
export async function runStarterConversionReminders(): Promise<{ scanned: number; sent: number }> {
  const cutoff = new Date(Date.now() - REMINDER_DELAY_MS);

  const candidates = await ChatSession.find({
    mode: 'business',
    status: 'confirmed',
    reminderSent: { $ne: true },
    createdAt: { $lte: cutoff },
  }).select('userId createdAt');

  let sent = 0;

  for (const session of candidates) {
    try {
      const user = await User.findById(session.userId).select('email plan');
      if (!user || user.plan !== 'starter') {
        // Plus Starter (déjà converti) ou compte supprimé : on marque quand
        // même pour ne plus jamais rescanner cette session.
        await ChatSession.updateOne({ _id: session._id }, { reminderSent: true });
        continue;
      }

      const hasSite = await Site.exists({ userId: user._id });
      if (hasSite) {
        await ChatSession.updateOne({ _id: session._id }, { reminderSent: true });
        continue;
      }

      await sendCoachBusinessReminderEmail(user.email);
      await ChatSession.updateOne({ _id: session._id }, { reminderSent: true });
      sent += 1;
    } catch (err) {
      // Best-effort : une erreur d'envoi sur une session ne doit jamais
      // bloquer le scan des autres, ni faire boucler indéfiniment le job.
      console.error(`[reminders] Échec relance session=${session._id}`, err);
    }
  }

  return { scanned: candidates.length, sent };
}
