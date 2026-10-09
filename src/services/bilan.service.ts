import { AppConfig } from '@/models/AppConfig';
import { User } from '@/models/User';
import { Site } from '@/models/Site';
import { CreditTransaction } from '@/models/CreditTransaction';
import { PaiementChariow } from '@/models/PaiementChariow';
import { VideoAd } from '@/models/VideoAd';
import { Logo } from '@/models/Logo';
import { Domain } from '@/models/Domain';
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

/** Une taxe ou cotisation, activable depuis l'admin. */
export type Taxe = { actif: boolean; pct: number };
export interface TaxesBilan {
  /** Cotisations URSSAF de la micro-entreprise, sur l'argent encaissé. */
  urssaf: Taxe;
  /** Versement libératoire de l'impôt sur le revenu, sur l'argent encaissé. */
  impot: Taxe;
  /** TVA ajoutée par Meta / TikTok sur les factures de pub (compte facturé en France). */
  tvaPub: Taxe;
}

export interface ReglagesBilan {
  fcfaParUsd: number;
  fraisChariowPct: number;
  coutsFixes: CoutFixe[];
  taxes: TaxesBilan;
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
  taxes: {
    urssaf: { actif: true, pct: 21.2 },
    impot: { actif: false, pct: 1.7 },
    tvaPub: { actif: true, pct: 20 },
  },
  simulation: {},
};

export async function lireReglages(): Promise<ReglagesBilan> {
  const ligne = await AppConfig.findOne({ key: CLE_REGLAGES }).lean();
  try {
    const v = ligne?.value ? JSON.parse(ligne.value) : {};
    const t = v.taxes ?? {};
    return {
      ...REGLAGES_DEFAUT,
      ...v,
      taxes: {
        urssaf: { ...REGLAGES_DEFAUT.taxes.urssaf, ...(t.urssaf ?? {}) },
        impot: { ...REGLAGES_DEFAUT.taxes.impot, ...(t.impot ?? {}) },
        tvaPub: { ...REGLAGES_DEFAUT.taxes.tvaPub, ...(t.tvaPub ?? {}) },
      },
      simulation: { ...(v.simulation ?? {}) },
    };
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
    taxes: r.taxes ?? actuel.taxes,
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

/**
 * Répartition du coût d'une vidéo entre les comptes fournisseurs :
 * voix off 20/30 s → Alexya ; formats longs, avatar et mini-film → fal.ai
 * (Kling, avatar) ; la voix (ElevenLabs) ≈ 8 % du coût. Estimation.
 */
function fournisseursVideo(mode?: string, format?: string): { alexya: number; fal: number; elevenlabs: number } {
  const cout = estimateVideoAdRealCostUsd(mode as never, format as never) ?? 0;
  const voix = cout * 0.08;
  const moteur = cout - voix;
  const alexya = mode === 'voix_off' && (format === '20s' || format === '30s');
  return { alexya: alexya ? moteur : 0, fal: alexya ? 0 : moteur, elevenlabs: voix };
}

/** Fournisseur (compte à approvisionner) d'un modèle IA mesuré. */
function fournisseurIa(modele: string): 'anthropic' | 'xai' | 'autre' {
  if (/^claude/i.test(modele)) return 'anthropic';
  if (/^grok/i.test(modele)) return 'xai';
  return 'autre';
}

/**
 * Pays d'un compte, en expression d'agrégation : le code pays à 2 lettres mis
 * dans le lien de la pub (utm_campaign=ci, sn, ng…) s'il y en a un, sinon le
 * pays choisi à l'inscription, sinon « ?? ».
 */
function PAYS_DU_COMPTE(doc: string) {
  const campagne = { $toUpper: { $ifNull: [`${doc}.acquisition.campagne`, ''] } };
  return {
    $cond: [
      { $regexMatch: { input: campagne, regex: /^[A-Z]{2}$/ } },
      campagne,
      {
        $cond: [
          { $gt: [{ $strLenCP: { $ifNull: [`${doc}.pays`, ''] } }, 0] },
          { $toUpper: `${doc}.pays` },
          '??',
        ],
      },
    ],
  };
}

/** Détail d'une fonction de la partie 5 : les derniers débits de la période (pour vérifier un chiffre). */
export async function detailConsommation(type: string, du: Date, au: Date) {
  const lignes = await CreditTransaction.find({ type, amount: { $lt: 0 }, createdAt: { $gte: du, $lt: au } })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('userId amount note createdAt')
    .populate('userId', 'email name')
    .lean();
  return lignes.map((l) => {
    const u = l.userId as unknown as { email?: string; name?: string } | null;
    return {
      le: l.createdAt,
      credits: -l.amount,
      compte: u?.email ?? '—',
      note: l.note ?? '',
    };
  });
}

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
    domainesAchetes,
    domainesARenouveler,
    inscritsParPays,
    abonnesParPays,
    encaisseParPays,
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
    Domain.find({ createdAt: plage }).select('renewalAnnualUsd registrar').lean(),
    Domain.find({ expiresAt: { $gte: new Date(), $lt: new Date(Date.now() + 30 * 86_400_000) }, status: { $ne: 'expire' } })
      .select('renewalAnnualUsd')
      .lean(),
    // ── Par pays : le code pays du lien de pub (utm_campaign=ci…), sinon le pays de l'inscription ──
    User.aggregate([
      { $match: { role: 'user', createdAt: plage } },
      { $group: { _id: PAYS_DU_COMPTE('$$ROOT'), n: { $sum: 1 } } },
    ]),
    CreditTransaction.aggregate([
      { $match: { type: 'achat_abonnement' } },
      { $group: { _id: '$userId', premier: { $min: '$createdAt' } } },
      { $match: { premier: plage } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $unwind: '$u' },
      { $group: { _id: PAYS_DU_COMPTE('$u'), n: { $sum: 1 } } },
    ]),
    CreditTransaction.aggregate([
      { $match: { type: { $in: ['achat_abonnement', 'achat_pack'] }, createdAt: plage } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
      { $unwind: '$u' },
      { $group: { _id: PAYS_DU_COMPTE('$u'), fcfa: { $sum: { $ifNull: ['$montantFcfa', 0] } } } },
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

  const tx = r.taxes;
  const pctSi = (t: Taxe) => (t.actif ? (Number(t.pct) || 0) / 100 : 0);
  const couts = {
    fraisChariow,
    ia: Math.round(coutIaUsd * taux),
    videos: Math.round(coutVideosUsd * taux),
    logos: Math.round(coutLogosUsd * taux),
    fixes: Math.round(fixesPeriodeUsd * taux),
    pub: pubFcfa,
    urssaf: Math.round(encaisse * pctSi(tx.urssaf)),
    impot: Math.round(encaisse * pctSi(tx.impot)),
    tvaPub: Math.round(pubFcfa * pctSi(tx.tvaPub)),
  };

  // Ce que chaque compte fournisseur a réellement consommé sur la période (USD).
  const consoComptes = { anthropic: 0, xai: 0, autreIa: 0, alexya: 0, fal: 0, elevenlabs: 0, recraft: coutLogosUsd };
  for (const m of iaParModele as { _id: string; usd: number }[]) {
    const f = fournisseurIa(m._id);
    if (f === 'anthropic') consoComptes.anthropic += m.usd;
    else if (f === 'xai') consoComptes.xai += m.usd;
    else consoComptes.autreIa += m.usd;
  }
  for (const v of videos as { mode?: string; format?: string }[]) {
    const f = fournisseursVideo(v.mode, v.format);
    consoComptes.alexya += f.alexya;
    consoComptes.fal += f.fal;
    consoComptes.elevenlabs += f.elevenlabs;
  }
  const sommeUsd = (l: unknown[]) =>
    (l as { renewalAnnualUsd?: number }[]).reduce((t, d) => t + (Number(d.renewalAnnualUsd) || 0), 0);
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

  const insPays = parCle(inscritsParPays);
  const aboPays = parCle(abonnesParPays);
  const encPays = Object.fromEntries(encaisseParPays.map((x: { _id: string; fcfa: number }) => [x._id, x.fcfa]));
  const parPays = Array.from(new Set([...Object.keys(insPays), ...Object.keys(aboPays), ...Object.keys(encPays)]))
    .map((code) => ({
      pays: code,
      inscrits: insPays[code] ?? 0,
      abonnes: aboPays[code] ?? 0,
      encaisseFcfa: encPays[code] ?? 0,
      conversion: insPays[code] ? (aboPays[code] ?? 0) / insPays[code] : null,
    }))
    .sort((a, b) => b.inscrits - a.inscrits || b.encaisseFcfa - a.encaisseFcfa);
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
    parPays,
    taxes: tx,
    approvisionnement: {
      consoUsd: Object.fromEntries(Object.entries(consoComptes).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      smsEnvoyes: telephonesVerifies,
      domainesAchetes: { nombre: domainesAchetes.length, usd: Math.round(sommeUsd(domainesAchetes)) },
      domainesARenouveler30j: { nombre: domainesARenouveler.length, usd: Math.round(sommeUsd(domainesARenouveler)) },
    },
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
