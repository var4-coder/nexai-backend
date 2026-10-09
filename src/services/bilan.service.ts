import { AppConfig } from '@/models/AppConfig';
import { User } from '@/models/User';
import { Site } from '@/models/Site';
import { CreditTransaction } from '@/models/CreditTransaction';
import { PaiementChariow } from '@/models/PaiementChariow';
import { VideoAd } from '@/models/VideoAd';
import { Logo } from '@/models/Logo';
import { StatsJour, DepensePub } from '@/models/StatsJour';
import { estimateVideoAdRealCostUsd } from '@/services/credits.service';
import { viderTamponIa } from '@/services/stats-jour.service';

/**
 * Bilan de l'admin.
 *
 * - « Direct » : chiffres RÉELS de NexAI sur une période (argent encaissé,
 *   coût IA mesuré à chaque appel, visiteurs, inscrits, abonnés, pub).
 * - Les réglages (coûts fixes, taux, hypothèses de la simulation) sont
 *   enregistrés côté serveur : tous les comptes admin voient les mêmes.
 */

const CLE_REGLAGES = 'bilan_reglages';

export type CoutFixe = { nom: string; usdParMois: number };

export interface ReglagesBilan {
  fcfaParUsd: number;
  fraisChariowPct: number;
  coutsFixes: CoutFixe[];
  /** Hypothèses de la simulation (curseurs), partagées entre admins. */
  simulation: Record<string, number | string | boolean>;
}

export const REGLAGES_DEFAUT: ReglagesBilan = {
  fcfaParUsd: 580,
  fraisChariowPct: 15,
  coutsFixes: [
    { nom: 'Render (serveur API + worker)', usdParMois: 25 },
    { nom: 'Upstash (Redis)', usdParMois: 10 },
    { nom: 'Netlify (site NexAI + sites clients)', usdParMois: 20 },
    { nom: 'MongoDB Atlas (base de données)', usdParMois: 0 },
    { nom: 'Brevo (emails, SMS)', usdParMois: 0 },
    { nom: 'Bunny Stream (vidéos Académie)', usdParMois: 1 },
  ],
  simulation: {},
};

export async function lireReglages(): Promise<ReglagesBilan> {
  const ligne = await AppConfig.findOne({ key: CLE_REGLAGES }).lean();
  try {
    const v = ligne?.value ? JSON.parse(ligne.value) : {};
    return { ...REGLAGES_DEFAUT, ...v, simulation: { ...(v.simulation ?? {}) } };
  } catch {
    return REGLAGES_DEFAUT;
  }
}

export async function enregistrerReglages(r: Partial<ReglagesBilan>) {
  const actuel = await lireReglages();
  const nouveau: ReglagesBilan = {
    fcfaParUsd: r.fcfaParUsd ?? actuel.fcfaParUsd,
    fraisChariowPct: r.fraisChariowPct ?? actuel.fraisChariowPct,
    coutsFixes: r.coutsFixes ?? actuel.coutsFixes,
    simulation: r.simulation ?? actuel.simulation,
  };
  await AppConfig.findOneAndUpdate(
    { key: CLE_REGLAGES },
    { key: CLE_REGLAGES, value: JSON.stringify(nouveau) },
    { upsert: true }
  );
  return nouveau;
}

const PLANS_PAYANTS = ['starter', 'createur', 'agence', 'pro_max'] as const;
const jour = (d: Date) => d.toISOString().slice(0, 10);
const PLATEFORMES_PUB = ['facebook', 'instagram', 'tiktok', 'google', 'autre'];

/** Coût moyen d'un logo (3 propositions Recraft V4.1 + rédaction des consignes). */
const COUT_LOGO_USD = 0.15;

export async function bilanReel(du: Date, au: Date) {
  await viderTamponIa().catch(() => {}); // inclure les appels des 30 dernières secondes
  const r = await lireReglages();
  const taux = r.fcfaParUsd;
  const plage = { $gte: du, $lt: au };
  const jDu = jour(du);
  const jAu = jour(new Date(au.getTime() - 1));
  const plageJour = { $gte: jDu, $lte: jAu };
  const nbJours = Math.max(1, Math.round((au.getTime() - du.getTime()) / 86_400_000));

  const [
    visitesParSource,
    visiteursParSource,
    inscrits,
    inscritsParSource,
    emailsVerifies,
    telephonesVerifies,
    sitesCrees,
    sitesEnLigne,
    abonnesActifs,
    paiements,
    premiersAbonnements,
    commissions,
    iaParModele,
    videos,
    logos,
    pub,
    consommation,
  ] = await Promise.all([
    StatsJour.aggregate([{ $match: { type: 'visite', jour: plageJour } }, { $group: { _id: '$cle', n: { $sum: '$nombre' } } }]),
    StatsJour.aggregate([{ $match: { type: 'visiteur', jour: plageJour } }, { $group: { _id: '$cle', n: { $sum: '$nombre' } } }]),
    User.countDocuments({ role: 'user', createdAt: plage }),
    User.aggregate([
      { $match: { role: 'user', createdAt: plage } },
      { $group: { _id: { $ifNull: ['$acquisition.source', 'inconnue'] }, n: { $sum: 1 } } },
    ]),
    User.countDocuments({ role: 'user', createdAt: plage, emailVerifiedAt: { $ne: null } }),
    User.countDocuments({ role: 'user', telephoneVerifieLe: plage }),
    Site.countDocuments({ createdAt: plage }),
    Site.countDocuments({ status: 'launched' }),
    User.aggregate([
      { $match: { role: 'user', plan: { $in: PLANS_PAYANTS as unknown as string[] }, planExpiresAt: { $gt: new Date() } } },
      { $group: { _id: '$plan', n: { $sum: 1 } } },
    ]),
    CreditTransaction.aggregate([
      { $match: { type: { $in: ['achat_abonnement', 'achat_pack'] }, createdAt: plage } },
      { $group: { _id: '$type', fcfa: { $sum: { $ifNull: ['$montantFcfa', 0] } }, n: { $sum: 1 } } },
    ]),
    // Nouveaux abonnés : premier paiement d'abonnement dans la période.
    CreditTransaction.aggregate([
      { $match: { type: 'achat_abonnement' } },
      { $group: { _id: '$userId', premier: { $min: '$createdAt' } } },
      { $match: { premier: plage } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $group: { _id: { $ifNull: [{ $arrayElemAt: ['$u.acquisition.source', 0] }, 'inconnue'] }, n: { $sum: 1 } } },
    ]),
    PaiementChariow.aggregate([
      { $match: { webhookReceivedAt: plage } },
      { $group: { _id: null, fcfa: { $sum: '$commissionNexai' }, ventes: { $sum: '$montant' }, n: { $sum: 1 } } },
    ]),
    StatsJour.aggregate([
      { $match: { type: 'ia', jour: plageJour } },
      { $group: { _id: '$cle', usd: { $sum: '$coutUsd' }, appels: { $sum: '$nombre' } } },
      { $sort: { usd: -1 } },
    ]),
    VideoAd.find({ status: 'completed', createdAt: plage }).select('mode format').lean(),
    Logo.countDocuments({ source: 'generated', createdAt: plage }),
    DepensePub.aggregate([{ $match: { jour: plageJour } }, { $group: { _id: '$plateforme', fcfa: { $sum: '$montantFcfa' } } }]),
    CreditTransaction.aggregate([
      { $match: { amount: { $lt: 0 }, createdAt: plage } },
      { $group: { _id: '$type', credits: { $sum: { $multiply: ['$amount', -1] } }, n: { $sum: 1 } } },
      { $sort: { credits: -1 } },
    ]),
  ]);

  const parCle = (a: { _id: string; n: number }[]) => Object.fromEntries(a.map((x) => [x._id, x.n]));
  const somme = (o: Record<string, number>) => Object.values(o).reduce((t, v) => t + v, 0);

  const visites = parCle(visitesParSource);
  const visiteurs = parCle(visiteursParSource);
  const inscritsSrc = parCle(inscritsParSource);
  const abonnesSrc = parCle(premiersAbonnements);
  const pubSrc = Object.fromEntries(pub.map((p: { _id: string; fcfa: number }) => [p._id, p.fcfa]));

  const abonnements = paiements.find((p: { _id: string }) => p._id === 'achat_abonnement')?.fcfa ?? 0;
  const packs = paiements.find((p: { _id: string }) => p._id === 'achat_pack')?.fcfa ?? 0;
  const commission = commissions[0]?.fcfa ?? 0;
  const encaisse = abonnements + packs + commission;
  const fraisChariow = Math.round(((abonnements + packs) * r.fraisChariowPct) / 100);

  const coutIaUsd = iaParModele.reduce((t: number, m: { usd: number }) => t + m.usd, 0);
  const coutVideosUsd = videos.reduce(
    (t: number, v: { mode?: string; format?: string }) =>
      t + (estimateVideoAdRealCostUsd(v.mode as never, v.format as never) ?? 0),
    0
  );
  const coutLogosUsd = logos * COUT_LOGO_USD;
  const fixesMoisUsd = r.coutsFixes.reduce((t, c) => t + (Number(c.usdParMois) || 0), 0);
  const fixesPeriodeUsd = (fixesMoisUsd * nbJours) / 30;
  const pubFcfa = somme(pubSrc);

  const couts = {
    fraisChariow,
    ia: Math.round(coutIaUsd * taux),
    videos: Math.round(coutVideosUsd * taux),
    logos: Math.round(coutLogosUsd * taux),
    fixes: Math.round(fixesPeriodeUsd * taux),
    pub: pubFcfa,
  };
  const totalCouts = Object.values(couts).reduce((t, v) => t + v, 0);

  const sources = Array.from(
    new Set([...Object.keys(visites), ...Object.keys(inscritsSrc), ...Object.keys(abonnesSrc), ...Object.keys(pubSrc), ...PLATEFORMES_PUB.slice(0, 3)])
  );
  const parSource = sources
    .map((s) => {
      const depense = pubSrc[s] ?? 0;
      const ins = inscritsSrc[s] ?? 0;
      const abo = abonnesSrc[s] ?? 0;
      return {
        source: s,
        depenseFcfa: depense,
        visites: visites[s] ?? 0,
        visiteurs: visiteurs[s] ?? 0,
        inscrits: ins,
        abonnes: abo,
        coutParInscrit: depense && ins ? Math.round(depense / ins) : null,
        coutParAbonne: depense && abo ? Math.round(depense / abo) : null,
        conversion: ins ? abo / ins : null,
      };
    })
    .filter((x) => x.depenseFcfa || x.visites || x.inscrits || x.abonnes || PLATEFORMES_PUB.slice(0, 3).includes(x.source))
    .sort((a, b) => b.depenseFcfa - a.depenseFcfa || b.inscrits - a.inscrits);

  const totalAbonnesNouveaux = somme(abonnesSrc);
  return {
    periode: { du: jDu, au: jAu, jours: nbJours },
    reglages: { fcfaParUsd: taux, fraisChariowPct: r.fraisChariowPct },
    entonnoir: {
      visiteurs: somme(visiteurs),
      visites: somme(visites),
      inscrits,
      emailsVerifies,
      telephonesVerifies,
      sitesCrees,
      nouveauxAbonnes: totalAbonnesNouveaux,
      conversion: inscrits ? totalAbonnesNouveaux / inscrits : null,
    },
    abonnesActifs: Object.fromEntries(PLANS_PAYANTS.map((p) => [p, parCle(abonnesActifs)[p] ?? 0])),
    sitesEnLigne,
    revenus: { abonnements, packs, commission, total: encaisse },
    couts,
    totalCouts,
    resultat: encaisse - totalCouts,
    detailIa: iaParModele.map((m: { _id: string; usd: number; appels: number }) => ({
      modele: m._id,
      appels: m.appels,
      fcfa: Math.round(m.usd * taux),
    })),
    detailFixes: r.coutsFixes.map((c) => ({ nom: c.nom, fcfa: Math.round(((Number(c.usdParMois) || 0) * nbJours * taux) / 30) })),
    production: { videos: videos.length, logos },
    consommation: consommation.map((c: { _id: string; credits: number; n: number }) => ({ type: c._id, credits: c.credits, nombre: c.n })),
    parSource,
  };
}

// ── Dépenses publicitaires (saisies par l'admin) ──

export async function listerDepensesPub(limite = 200) {
  return DepensePub.find().sort({ jour: -1, createdAt: -1 }).limit(limite).lean();
}

export async function ajouterDepensePub(d: { jour: string; plateforme: string; montantFcfa: number; note?: string }) {
  return DepensePub.create(d);
}

export async function supprimerDepensePub(id: string) {
  await DepensePub.deleteOne({ _id: id });
}
