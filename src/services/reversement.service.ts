import { Types } from 'mongoose';
import { Reversement } from '@/models/Reversement';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';

/**
 * Méthode de retrait — mode "Compte NexAI" (Architecture v6, section 12).
 *
 * NexAI encaisse les ventes réalisées sur les sites de ses clients, puis
 * reverse manuellement (Mobile Money / USDT BEP-20 / BTC). Ce service tient
 * la comptabilité : solde dû, historique, et enregistrement des versements.
 *
 * Le reversement réel est TOUJOURS manuel côté admin — aucun virement
 * automatique n'est déclenché par NexAI (décision produit assumée : pas
 * d'automatisation bancaire).
 *
 * Ne concerne jamais le mode 'lien_personnel' : dans ce mode l'argent va
 * directement du visiteur au client, NexAI n'est pas intermédiaire.
 */

export interface SoldeReversement {
  encaisseFcfa: number;
  reverseFcfa: number;
  enAttenteFcfa: number;
}

/**
 * Calcule le solde d'un client en une seule agrégation Mongo :
 * en attente = encaissé − déjà reversé.
 */
export async function getSoldeReversement(userId: Types.ObjectId | string): Promise<SoldeReversement> {
  const rows = await Reversement.aggregate<{ _id: string; total: number }>([
    { $match: { userId: new Types.ObjectId(String(userId)) } },
    { $group: { _id: '$type', total: { $sum: '$amountFcfa' } } },
  ]);

  const encaisseFcfa = rows.find((r) => r._id === 'encaissement_visiteur')?.total ?? 0;
  const reverseFcfa = rows.find((r) => r._id === 'reversement_admin')?.total ?? 0;

  return {
    encaisseFcfa,
    reverseFcfa,
    // Jamais négatif : un reversement supérieur à l'encaissé (erreur de
    // saisie admin) ne doit pas afficher un solde absurde côté client.
    enAttenteFcfa: Math.max(0, encaisseFcfa - reverseFcfa),
  };
}

/** Historique chronologique (encaissements + reversements) d'un client. */
export async function getHistoriqueReversement(
  userId: Types.ObjectId | string,
  limit = 50
) {
  const rows = await Reversement.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();

  return rows.map((r) => ({
    id: String(r._id),
    type: r.type,
    amountFcfa: r.amountFcfa,
    date: r.reversedAt ?? r.createdAt,
    reference: r.reference ?? null,
    note: r.note ?? null,
    siteId: r.siteId ? String(r.siteId) : null,
  }));
}

/**
 * Enregistre un encaissement reçu pour le compte d'un client (appelé par le
 * webhook de paiement quand le site encaisse en mode 'nexai').
 */
export async function enregistrerEncaissement(params: {
  userId: Types.ObjectId | string;
  siteId?: Types.ObjectId | string;
  amountFcfa: number;
  reference?: string;
  note?: string;
}) {
  if (params.amountFcfa <= 0) {
    throw new AppError("Le montant d'un encaissement doit être positif.", 400);
  }
  return Reversement.create({
    userId: params.userId,
    siteId: params.siteId,
    type: 'encaissement_visiteur',
    amountFcfa: params.amountFcfa,
    reference: params.reference,
    note: params.note,
  });
}

/**
 * Enregistre un versement effectivement réalisé par l'admin ("Marquer comme
 * reversé"). Refuse de dépasser le solde dû — protection contre une double
 * saisie accidentelle qui ferait croire au client qu'il a été payé deux fois.
 */
export async function marquerCommeReverse(params: {
  userId: Types.ObjectId | string;
  amountFcfa: number;
  reference?: string;
  note?: string;
  adminEmail: string;
  dateVersement?: Date;
}) {
  if (params.amountFcfa <= 0) {
    throw new AppError('Le montant du reversement doit être positif.', 400);
  }

  const user = await User.findById(params.userId).select('email compteReversement');
  if (!user) throw new AppError('Client introuvable.', 404);

  const solde = await getSoldeReversement(params.userId);
  if (params.amountFcfa > solde.enAttenteFcfa) {
    throw new AppError(
      `Montant supérieur au solde dû (${solde.enAttenteFcfa.toLocaleString('fr-FR')} FCFA en attente).`,
      400
    );
  }

  return Reversement.create({
    userId: params.userId,
    type: 'reversement_admin',
    amountFcfa: params.amountFcfa,
    reversedBy: params.adminEmail,
    reversedAt: params.dateVersement ?? new Date(),
    reference: params.reference,
    note: params.note,
  });
}

/**
 * File de reversement côté admin : tous les clients ayant un solde dû > 0,
 * triés par montant décroissant (les plus gros à payer en premier).
 */
export async function listerClientsAReverser() {
  const rows = await Reversement.aggregate<{
    _id: Types.ObjectId;
    encaisse: number;
    reverse: number;
  }>([
    {
      $group: {
        _id: '$userId',
        encaisse: {
          $sum: { $cond: [{ $eq: ['$type', 'encaissement_visiteur'] }, '$amountFcfa', 0] },
        },
        reverse: {
          $sum: { $cond: [{ $eq: ['$type', 'reversement_admin'] }, '$amountFcfa', 0] },
        },
      },
    },
    { $addFields: { enAttente: { $subtract: ['$encaisse', '$reverse'] } } },
    { $match: { enAttente: { $gt: 0 } } },
    { $sort: { enAttente: -1 } },
    { $limit: 200 },
  ]);

  if (rows.length === 0) return [];

  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('email plan compteReversement')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return rows.map((r) => {
    const u = byId.get(String(r._id));
    return {
      userId: String(r._id),
      email: u?.email ?? '(compte supprimé)',
      plan: u?.plan ?? null,
      encaisseFcfa: r.encaisse,
      reverseFcfa: r.reverse,
      enAttenteFcfa: r.encaisse - r.reverse,
      // Coordonnées de versement renseignées par le client — l'admin en a
      // besoin pour effectuer le virement réel.
      compteReversement: u?.compteReversement ?? null,
    };
  });
}
