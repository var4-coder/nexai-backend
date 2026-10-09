/**
 * Impôts et cotisations de NexAI selon le pays où l'activité est déclarée.
 *
 * FICHIER PARTAGÉ : une copie identique existe côté serveur
 * (src/services/fiscalite.ts ; côté site : lib/fiscalite.ts). Modifier les deux ensemble.
 *
 * Règles vérifiées le 9 octobre 2026 (sources dans le Bilan). Ce sont des
 * estimations pour piloter NexAI, pas une déclaration : à faire valider par
 * un expert-comptable du pays choisi.
 *
 * Tous les montants sont en FCFA. Les seuils et minimums sont ANNUELS : le
 * calcul ramène la période à une année, applique la règle, puis reprend la
 * part de la période.
 */

export type PaysFiscal = 'FR' | 'BJ' | 'SN';

/**
 * Taux, plafonds et minimums de chaque pays. Modifiables dans l'admin : quand
 * une loi de finances change un taux, on le corrige ici sans toucher au code.
 */
export interface Baremes {
  /** Date de la dernière vérification des taux (AAAA-MM-JJ). */
  verifieLe: string;
  france: {
    urssafBncPct: number;
    urssafBicPct: number;
    cfpBncPct: number;
    cfpBicPct: number;
    vlBncPct: number;
    vlBicPct: number;
    plafondMicroEuros: number;
  };
  benin: {
    tpsPct: number;
    tpsMinimum: number;
    tpsRedevance: number;
    plafondTps: number;
    isPct: number;
    minimumPctCa: number;
    minimumPlancher: number;
    tvaPct: number;
  };
  senegal: {
    /** Barème CGU services : [haut de tranche en F, taux en %]. */
    cguTranches: [number, number][];
    cguMinimum: number;
    plafondCgu: number;
    isPct: number;
    imfPctCa: number;
    imfPlancher: number;
    imfPlafond: number;
    tvaPct: number;
  };
}

export const BAREMES_DEFAUT: Baremes = {
  verifieLe: '2026-10-09',
  france: { urssafBncPct: 25.6, urssafBicPct: 21.2, cfpBncPct: 0.2, cfpBicPct: 0.1, vlBncPct: 2.2, vlBicPct: 1.7, plafondMicroEuros: 83_600 },
  benin: { tpsPct: 5, tpsMinimum: 10_000, tpsRedevance: 4_000, plafondTps: 50_000_000, isPct: 30, minimumPctCa: 1, minimumPlancher: 250_000, tvaPct: 18 },
  senegal: {
    cguTranches: [
      [500_000, 4],
      [3_000_000, 5],
      [10_000_000, 6],
      [37_000_000, 7],
      [50_000_000, 8],
    ],
    cguMinimum: 30_000,
    plafondCgu: 50_000_000,
    isPct: 30,
    imfPctCa: 0.5,
    imfPlancher: 500_000,
    imfPlafond: 5_000_000,
    tvaPct: 18,
  },
};

export interface Fiscalite {
  pays: PaysFiscal;
  baremes: Baremes;
  france: {
    /** BNC (conseil / développement informatique) ou BIC services (édition de logiciel). */
    activite: 'bnc' | 'bic';
    /** Réduction ACRE sur les cotisations : 0, 25 (création après le 1er juillet 2026) ou 50 %. */
    acrePct: 0 | 25 | 50;
    /** Option pour le versement libératoire de l'impôt sur le revenu. */
    versementLiberatoire: boolean;
    /** CFE annuelle (0 l'année de création). */
    cfeAnnuelleFcfa: number;
  };
  benin: {
    /** Entreprise individuelle (TPS possible sous 50 M) ou société (IS). */
    forme: 'individuelle' | 'societe';
    /** Exonération de TPS des 12 premiers mois après la création. */
    premiereAnnee: boolean;
    /** Réduction d'IS d'une société nouvelle : 25 % (années 1 et 2), 50 % (année 3). */
    reductionIsPct: 0 | 25 | 50;
  };
  senegal: {
    forme: 'individuelle' | 'societe';
    /** Société de moins de 3 ans : pas d'impôt minimum forfaitaire (IMF). */
    moinsDe3Ans: boolean;
  };
}

export const FISCALITE_DEFAUT: Fiscalite = {
  pays: 'FR',
  baremes: BAREMES_DEFAUT,
  france: { activite: 'bnc', acrePct: 0, versementLiberatoire: false, cfeAnnuelleFcfa: 0 },
  benin: { forme: 'individuelle', premiereAnnee: false, reductionIsPct: 0 },
  senegal: { forme: 'individuelle', moinsDe3Ans: true },
};

export const NOM_PAYS_FISCAL: Record<PaysFiscal, string> = { FR: 'France', BJ: 'Bénin', SN: 'Sénégal' };
export const FCFA_PAR_EURO = 655.957;

export interface LigneImpot {
  nom: string;
  fcfa: number;
}
export interface ResultatFiscal {
  pays: PaysFiscal;
  regime: string;
  lignes: LigneImpot[];
  total: number;
  /** Alertes : plafond dépassé, point à vérifier… */
  alertes: string[];
}

export interface BaseFiscale {
  /** Argent encaissé sur la période (chiffre d'affaires), FCFA. */
  ca: number;
  /** Bénéfice de la période AVANT impôts (encaissé − coûts), FCFA. */
  beneficeAvantImpot: number;
  /** Part de l'encaissé venant de clients du pays de déclaration (TVA locale), FCFA. */
  caClientsDuPays: number;
  /** Durée de la période, en jours. */
  jours: number;
}

const r = Math.round;

/** CGU du Sénégal (services) : barème progressif par tranches de CA annuel. */
function cguSenegal(caAnnuel: number, t: Baremes['senegal']): number {
  const tranches = t.cguTranches.map(([h, p]) => [h, p / 100] as [number, number]);
  let reste = caAnnuel;
  let bas = 0;
  let impot = 0;
  for (const [haut, taux] of tranches) {
    const part = Math.max(0, Math.min(reste, haut - bas));
    impot += part * taux;
    reste -= part;
    bas = haut;
    if (reste <= 0) break;
  }
  return Math.max(t.cguMinimum, impot);
}

export function calculerImpots(f: Fiscalite, b: BaseFiscale, pays: PaysFiscal = f.pays): ResultatFiscal {
  const an = 365 / Math.max(1, b.jours); // période → année
  const part = 1 / an; // année → période
  const caAn = b.ca * an;
  const benefAn = b.beneficeAvantImpot * an;
  const lignes: LigneImpot[] = [];
  const alertes: string[] = [];
  const age = (Date.now() - new Date(f.baremes.verifieLe).getTime()) / 86_400_000;
  if (!(age < 183))
    alertes.push(`Taux vérifiés le ${f.baremes.verifieLe} : plus de 6 mois. Vérifiez la dernière loi de finances et mettez les taux à jour dans les barèmes.`);
  // TVA 18 % comprise dans le prix payé par un client du pays (prix TTC).
  const B = f.baremes;
  const tvaLocale = (pct: number) => (b.caClientsDuPays * pct) / (100 + pct);
  const pc = (n: number) => String(n).replace('.', ',');

  if (pays === 'FR') {
    const o = f.france;
    const t = B.france;
    const bnc = o.activite === 'bnc';
    const cot = bnc ? t.urssafBncPct : t.urssafBicPct;
    const cfp = bnc ? t.cfpBncPct : t.cfpBicPct;
    const vl = bnc ? t.vlBncPct : t.vlBicPct;
    lignes.push({ nom: `URSSAF (${pc(cot)} %${o.acrePct ? `, ACRE −${o.acrePct} %` : ''})`, fcfa: r((b.ca * cot * (1 - o.acrePct / 100)) / 100) });
    lignes.push({ nom: `Formation professionnelle (${pc(cfp)} %)`, fcfa: r((b.ca * cfp) / 100) });
    if (o.versementLiberatoire) lignes.push({ nom: `Impôt, versement libératoire (${pc(vl)} %)`, fcfa: r((b.ca * vl) / 100) });
    if (o.cfeAnnuelleFcfa) lignes.push({ nom: 'CFE (au prorata)', fcfa: r(o.cfeAnnuelleFcfa * part) });
    if (caAn / FCFA_PAR_EURO > t.plafondMicroEuros)
      alertes.push(`Au rythme actuel, le CA annuel dépasse ${t.plafondMicroEuros.toLocaleString('fr-FR')} € : sortie de la micro-entreprise (passage au réel ou en société).`);
    alertes.push('Ventes à des clients hors Union européenne : pas de TVA française (« TVA non applicable, art. 259 B du CGI »).');
    if (!o.versementLiberatoire) alertes.push('Sans versement libératoire, l’impôt sur le revenu se paie une fois par an, selon votre foyer : non compté ici.');
    return { pays, regime: `Micro-entreprise ${o.activite === 'bnc' ? 'BNC' : 'BIC services'}`, lignes, total: lignes.reduce((t, l) => t + l.fcfa, 0), alertes };
  }

  if (pays === 'BJ') {
    const o = f.benin;
    const t = B.benin;
    if (o.forme === 'individuelle' && caAn < t.plafondTps) {
      const tps = o.premiereAnnee ? 0 : Math.max(t.tpsMinimum, (t.tpsPct / 100) * caAn) + t.tpsRedevance;
      lignes.push({
        nom: o.premiereAnnee
          ? 'TPS : exonérée les 12 premiers mois'
          : `TPS (${pc(t.tpsPct)} % du CA, minimum ${t.tpsMinimum.toLocaleString('fr-FR')} F + ${t.tpsRedevance.toLocaleString('fr-FR')} F de redevance)`,
        fcfa: r(tps * part),
      });
      return { pays, regime: 'Entreprise individuelle, TPS', lignes, total: lignes.reduce((t, l) => t + l.fcfa, 0), alertes };
    }
    if (o.forme === 'individuelle') alertes.push('Au rythme actuel, le CA annuel dépasse le plafond de la TPS : passage au régime réel.');
    const isBrut = (t.isPct / 100) * Math.max(0, benefAn);
    const minimum = Math.max(t.minimumPlancher, (t.minimumPctCa / 100) * caAn);
    const isAn = Math.max(isBrut, minimum) * (1 - o.reductionIsPct / 100);
    lignes.push({
      nom: `Impôt sur les sociétés (${pc(t.isPct)} % du bénéfice, minimum ${pc(t.minimumPctCa)} % du CA et ${t.minimumPlancher.toLocaleString('fr-FR')} F${o.reductionIsPct ? `, réduction −${o.reductionIsPct} %` : ''})`,
      fcfa: r(isAn * part),
    });
    lignes.push({ nom: `TVA ${pc(t.tvaPct)} % sur les ventes aux clients du Bénin`, fcfa: r(tvaLocale(t.tvaPct)) });
    return { pays, regime: o.forme === 'societe' ? 'Société, régime réel' : 'Régime réel', lignes, total: lignes.reduce((t, l) => t + l.fcfa, 0), alertes };
  }

  // Sénégal
  const o = f.senegal;
  const t = B.senegal;
  if (o.forme === 'individuelle' && caAn <= t.plafondCgu) {
    const taux = t.cguTranches.map(([, p]) => p);
    lignes.push({
      nom: `CGU (barème ${pc(Math.min(...taux))} à ${pc(Math.max(...taux))} % par tranche de CA, minimum ${t.cguMinimum.toLocaleString('fr-FR')} F)`,
      fcfa: r(cguSenegal(caAn, t) * part),
    });
    return { pays, regime: 'Entreprise individuelle, CGU', lignes, total: lignes.reduce((t, l) => t + l.fcfa, 0), alertes };
  }
  if (o.forme === 'individuelle') alertes.push('Au rythme actuel, le CA annuel dépasse le plafond de la CGU : passage au régime réel.');
  const isBrut = (t.isPct / 100) * Math.max(0, benefAn);
  const imf = o.moinsDe3Ans ? 0 : Math.min(t.imfPlafond, Math.max(t.imfPlancher, (t.imfPctCa / 100) * caAn));
  lignes.push({
    nom: `Impôt sur les sociétés (${pc(t.isPct)} % du bénéfice${o.moinsDe3Ans ? ', pas de minimum les 3 premières années' : `, minimum ${pc(t.imfPctCa)} % du CA`})`,
    fcfa: r(Math.max(isBrut, imf) * part),
  });
  lignes.push({ nom: `TVA ${pc(t.tvaPct)} % sur les ventes aux clients du Sénégal`, fcfa: r(tvaLocale(t.tvaPct)) });
  return { pays, regime: o.forme === 'societe' ? 'Société, régime réel' : 'Régime réel', lignes, total: lignes.reduce((t, l) => t + l.fcfa, 0), alertes };
}

/** Les trois pays, avec les mêmes chiffres : pour choisir où déclarer NexAI. */
export function comparerPays(f: Fiscalite, b: BaseFiscale & { caParPays?: Record<string, number> }): ResultatFiscal[] {
  return (['FR', 'BJ', 'SN'] as PaysFiscal[]).map((p) =>
    calculerImpots(f, { ...b, caClientsDuPays: p === 'FR' ? 0 : b.caParPays?.[p] ?? b.caClientsDuPays }, p)
  );
}

/** Lit des réglages enregistrés (anciens ou partiels) en complétant avec les valeurs par défaut. */
export function normaliserFiscalite(v: unknown): Fiscalite {
  const x = (v ?? {}) as Partial<Fiscalite>;
  const bx = (x.baremes ?? {}) as Partial<Baremes>;
  const tranches = Array.isArray(bx.senegal?.cguTranches) && bx.senegal!.cguTranches.length ? bx.senegal!.cguTranches : BAREMES_DEFAUT.senegal.cguTranches;
  return {
    pays: x.pays === 'BJ' || x.pays === 'SN' ? x.pays : 'FR',
    baremes: {
      verifieLe: typeof bx.verifieLe === 'string' ? bx.verifieLe : BAREMES_DEFAUT.verifieLe,
      france: { ...BAREMES_DEFAUT.france, ...(bx.france ?? {}) },
      benin: { ...BAREMES_DEFAUT.benin, ...(bx.benin ?? {}) },
      senegal: { ...BAREMES_DEFAUT.senegal, ...(bx.senegal ?? {}), cguTranches: tranches },
    },
    france: { ...FISCALITE_DEFAUT.france, ...(x.france ?? {}) },
    benin: { ...FISCALITE_DEFAUT.benin, ...(x.benin ?? {}) },
    senegal: { ...FISCALITE_DEFAUT.senegal, ...(x.senegal ?? {}) },
  };
}

/** Où vérifier les taux (affiché à côté des barèmes). */
export const SOURCES_FISCALES: Record<PaysFiscal, { nom: string; url: string }[]> = {
  FR: [
    { nom: 'URSSAF : taux des micro-entrepreneurs', url: 'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/lessentiel-du-statut.html' },
    { nom: 'Service-public : micro-entreprise', url: 'https://entreprendre.service-public.gouv.fr/vosdroits/F23961' },
  ],
  BJ: [
    { nom: 'DGI Bénin : Code général des impôts', url: 'https://impots.finances.gouv.bj/' },
    { nom: 'Création en ligne (APIEx)', url: 'https://monentreprise.bj/' },
  ],
  SN: [
    { nom: 'DGID Sénégal : textes et Code général des impôts', url: 'https://www.dgid.sn/' },
    { nom: 'Création en ligne (APIX)', url: 'https://creationdentreprise.sn/' },
  ],
};
