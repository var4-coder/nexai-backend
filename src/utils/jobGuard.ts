import { Types } from 'mongoose';
import { Job, JobType } from '@/models/Job';
import { AppError } from '@/middleware/errorHandler';

/**
 * Protection anti double-commande.
 *
 * Le problème résolu
 * ------------------
 * Tous les jobs BullMQ sont créés avec un identifiant contenant `Date.now()`
 * (`launch_<siteId>_<timestamp>`), ce qui les rend TOUJOURS uniques : BullMQ ne
 * peut donc rien dédupliquer. Or les crédits sont débités AVANT la mise en
 * file. Conséquence : deux clics rapides sur « Mettre en ligne », un
 * double-tap mobile, ou un simple rejeu réseau débitaient le client deux fois
 * et lançaient deux générations facturées.
 *
 * La protection
 * -------------
 * Avant tout débit, on refuse une nouvelle demande du même type sur la même
 * ressource si une précédente est encore en cours (`queued` ou `active`), ou
 * si une demande identique vient d'être acceptée il y a quelques secondes.
 *
 * Deux garde-fous complémentaires :
 *  - `queued`/`active` : couvre toute la durée réelle du traitement.
 *  - fenêtre de quelques secondes : couvre l'instant où le job vient d'être
 *    créé mais où le statut n'est pas encore à jour, et le cas d'un job
 *    terminé très vite suivi d'un second clic parti en même temps.
 *
 * Volontairement une erreur explicite plutôt qu'un silence : le client doit
 * comprendre que sa demande est déjà partie, pas croire que rien ne s'est
 * passé et recliquer.
 */

/**
 * Fenêtre pendant laquelle deux demandes identiques sont considérées comme un
 * double envoi. Assez longue pour couvrir un double clic ou un rejeu réseau,
 * assez courte pour ne jamais gêner une vraie seconde demande volontaire.
 */
const DUPLICATE_WINDOW_MS = 10_000;

/** Statuts qui signifient « un traitement est déjà en cours ». */
const ACTIVE_STATUSES = ['queued', 'active'] as const;

export class DuplicateRequestError extends AppError {
  constructor(message: string) {
    // 409 Conflict : la demande est valide mais entre en conflit avec l'état
    // courant. Le frontend peut la distinguer d'une vraie erreur.
    super(message, 409);
  }
}

/**
 * Refuse la demande si une opération du même type est déjà en cours sur ce
 * site, ou si une demande identique vient juste d'être acceptée.
 *
 * À appeler AVANT tout débit de crédits.
 *
 * @param siteId  ressource concernée
 * @param type    type de job (un lancement n'empêche pas une modification)
 * @param message message montré au client
 */
export async function assertNoDuplicateJob(
  siteId: Types.ObjectId | string,
  type: JobType,
  message: string
): Promise<void> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);

  const existing = await Job.findOne({
    siteId,
    type,
    $or: [
      { status: { $in: ACTIVE_STATUSES } },
      { createdAt: { $gte: since } },
    ],
  })
    .select('_id status createdAt')
    .lean();

  if (existing) {
    throw new DuplicateRequestError(message);
  }
}
