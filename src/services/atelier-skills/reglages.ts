import { SkillSettings, SkillSettingsHistorique, type ISkillSettings, type IPosteReglage } from '@/models/AtelierSkills';
import { AppError } from '@/middleware/errorHandler';

/**
 * Réglages de l'Atelier Skills (avenant v1.3, §2 et §8) : modèle et effort
 * par poste, seuils, plafond, nombre de cas, passages, table des prix, mode
 * renforcé et consignes. Tout se change depuis l'admin, sans toucher au code.
 *
 * Identifiants vérifiés le 03/10/2026 sur les pages officielles :
 *  · gpt-6-astra (10 / 50 $), gpt-5.6-sol (4 / 20 $), gpt-6-luna (0,10 / 0,50 $) — OpenAI ;
 *  · deepseek-flash = DeepSeek V4.1 Flash. L'ancien « deepseek-v4-flash » est un
 *    alias retiré (redirigé). Tarif officiel heure pleine 0,30 / 1,20 $ (0,15 / 0,60 $ heures creuses) ;
 *  · claude-sonnet-5-5 (2 / 10 $), claude-opus-5-5 (4 / 20 $), claude-fable-5-1 (10 / 50 $) — Anthropic ;
 *  · grok-4.7 et grok-4.6 (2 / 6 $) — xAI, déjà utilisés par NexAI.
 * Les recherches web / X de Grok 4.7 ne sont pas comptées (non publiées en prix unitaire ici).
 */

export const POSTES: Record<string, { libelle: string; consigne: string; defaut: IPosteReglage; autorises: string[] }> = {
  cadreur: { libelle: 'Cadreur', consigne: 'P0', defaut: { modele: 'claude-opus-5-5', effort: 'medium' }, autorises: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
  documentaliste: { libelle: 'Documentaliste (recherche web + X)', consigne: 'P1', defaut: { modele: 'grok-4.7', effort: 'medium' }, autorises: ['grok-4.7', 'grok-4.6'] },
  redacteur1: { libelle: 'Rédacteur 1', consigne: 'P2, P6', defaut: { modele: 'gpt-5.6-sol', effort: 'medium' }, autorises: ['gpt-5.6-sol', 'claude-opus-5-5', 'gpt-6-astra'] },
  redacteur2: { libelle: 'Rédacteur 2', consigne: 'P2, P6', defaut: { modele: 'claude-sonnet-5-5', effort: 'medium' }, autorises: ['claude-sonnet-5-5', 'claude-opus-5-5'] },
  redacteur3: { libelle: 'Rédacteur 3', consigne: 'P2, P6', defaut: { modele: 'grok-4.6', effort: 'medium' }, autorises: ['grok-4.6', 'grok-4.7'] },
  panel_avance: { libelle: 'Panel de test — avancé', consigne: 'P7, P8', defaut: { modele: 'claude-sonnet-5-5', effort: 'low' }, autorises: ['claude-sonnet-5-5', 'grok-4.6', 'gpt-5.6-sol'] },
  panel_leger: { libelle: 'Panel de test — léger', consigne: 'P7, P8', defaut: { modele: 'deepseek-flash', effort: 'defaut' }, autorises: ['deepseek-flash', 'gpt-6-luna'] },
  evaluateur: { libelle: 'Évaluateur (aveugle)', consigne: 'P9', defaut: { modele: 'grok-4.6', effort: 'low' }, autorises: ['grok-4.6', 'grok-4.7', 'claude-sonnet-5-5'] },
  juge: { libelle: 'Juge et assembleur', consigne: "P5'", defaut: { modele: 'claude-opus-5-5', effort: 'medium' }, autorises: ['claude-opus-5-5', 'claude-fable-5-1'] },
  livrables: { libelle: 'Rédacteur de livrables', consigne: 'P12', defaut: { modele: 'claude-sonnet-5-5', effort: 'low' }, autorises: ['claude-sonnet-5-5', 'claude-opus-5-5'] },
  evaluateur_renforce: { libelle: 'Évaluateur renforcé (produit phare)', consigne: 'P9', defaut: { modele: 'claude-fable-5-1', effort: 'medium' }, autorises: ['claude-fable-5-1', 'claude-opus-5-5'] },
};

export const PRIX_DEFAUT: ISkillSettings['prix'] = {
  'claude-opus-5-5': { entree: 4, sortie: 20, cache: 0.2 },
  'claude-sonnet-5-5': { entree: 2, sortie: 10, cache: 0.2 },
  'claude-fable-5-1': { entree: 10, sortie: 50, cache: 0.25 },
  'grok-4.7': { entree: 2, sortie: 6, cache: 0.5 },
  'grok-4.6': { entree: 2, sortie: 6, cache: 0.5 },
  'gpt-6-astra': { entree: 10, sortie: 50, cache: 1 },
  'gpt-5.6-sol': { entree: 4, sortie: 20, cache: 0.4 },
  'gpt-6-luna': { entree: 0.1, sortie: 0.5, cache: 0.01 },
  'deepseek-flash': { entree: 0.3, sortie: 1.2, cache: 0.006 },
};

/**
 * Les identifiants de modèle contiennent des points (« grok-4.7 ») : en base,
 * les clés de la table des prix sont encodées pour ne jamais être lues comme
 * des chemins MongoDB.
 */
const POINT = '__';
export function encoderPrix(prix: ISkillSettings['prix']): ISkillSettings['prix'] {
  return Object.fromEntries(Object.entries(prix ?? {}).map(([k, v]) => [k.split('.').join(POINT), v]));
}
export function decoderPrix(prix: ISkillSettings['prix'] | undefined): ISkillSettings['prix'] {
  return Object.fromEntries(Object.entries(prix ?? {}).map(([k, v]) => [k.split(POINT).join('.'), v]));
}

export function reglagesDefaut(): Omit<ISkillSettings, '_id'> {
  return {
    version: 1,
    postes: Object.fromEntries(Object.entries(POSTES).map(([k, v]) => [k, { ...v.defaut }])),
    seuils: { note: 80, controlePct: 85, declenchementMin: 10, egalite: 1, ecartAvanceLeger: 0.25, affinite: 70, casEchoue: 0.5 },
    plafondUSD: 4,
    nbCasEntrainement: 8,
    nbCasControle: 4,
    passages: 1,
    modeRenforce: true,
    prix: { ...PRIX_DEFAUT },
    consignes: {},
  };
}

/** Réglages complets (valeurs par défaut pour tout champ absent). */
export async function lireReglages(): Promise<ISkillSettings> {
  const doc = (await SkillSettings.findById('atelier').lean()) as ISkillSettings | null;
  const d = reglagesDefaut();
  if (!doc) return { _id: 'atelier', ...d };
  return {
    _id: 'atelier',
    version: doc.version ?? 1,
    postes: { ...d.postes, ...(doc.postes ?? {}) },
    seuils: { ...d.seuils, ...(doc.seuils ?? {}) },
    plafondUSD: doc.plafondUSD ?? d.plafondUSD,
    nbCasEntrainement: doc.nbCasEntrainement ?? d.nbCasEntrainement,
    nbCasControle: doc.nbCasControle ?? d.nbCasControle,
    passages: doc.passages ?? d.passages,
    modeRenforce: doc.modeRenforce ?? d.modeRenforce,
    prix: { ...d.prix, ...decoderPrix(doc.prix) },
    consignes: doc.consignes ?? {},
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

/** Enregistre de nouveaux réglages (version +1, ancienne version archivée). */
export async function modifierReglages(patch: Partial<ISkillSettings>, par: string): Promise<ISkillSettings> {
  const actuels = await lireReglages();
  if (patch.postes) {
    for (const [poste, r] of Object.entries(patch.postes)) {
      const def = POSTES[poste];
      if (!def) throw new AppError(`Poste inconnu : ${poste}`, 400);
      if (!def.autorises.includes(r.modele)) {
        throw new AppError(`Modèle « ${r.modele} » non prévu pour le poste ${def.libelle}. Autorisés : ${def.autorises.join(', ')}`, 400);
      }
    }
  }
  if (patch.prix) {
    for (const [m, p] of Object.entries(patch.prix)) {
      if (![p.entree, p.sortie, p.cache].every((x) => typeof x === 'number' && x >= 0 && x < 1000)) {
        throw new AppError(`Prix invalide pour ${m}.`, 400);
      }
    }
  }
  await SkillSettingsHistorique.create({ version: actuels.version, contenu: { ...actuels, prix: encoderPrix(actuels.prix) }, par });
  const nouveaux: ISkillSettings = {
    ...actuels,
    ...patch,
    postes: { ...actuels.postes, ...(patch.postes ?? {}) },
    seuils: { ...actuels.seuils, ...(patch.seuils ?? {}) },
    prix: { ...actuels.prix, ...(patch.prix ?? {}) },
    consignes: { ...actuels.consignes, ...(patch.consignes ?? {}) },
    version: actuels.version + 1,
    updatedBy: par,
  };
  // Une consigne vidée revient au texte par défaut.
  for (const [k, v] of Object.entries(nouveaux.consignes)) if (!String(v ?? '').trim()) delete nouveaux.consignes[k];
  const { _id: _ignore, updatedAt: _u, ...aEcrire } = nouveaux;
  await SkillSettings.updateOne({ _id: 'atelier' }, { $set: { ...aEcrire, prix: encoderPrix(aEcrire.prix) } }, { upsert: true });
  return lireReglages();
}

/**
 * Coût estimé d'une exécution (avenant v1.3 §9, mêmes hypothèses de jetons),
 * recalculé avec la table des prix et les modèles réglés. Indicatif : le
 * coût réel mesuré à chaque étape fait foi.
 */
export function coutEstime(r: ISkillSettings, produitPhare: boolean): number {
  const prix = (poste: string) => r.prix[r.postes[poste]?.modele] ?? { entree: 0, sortie: 0, cache: 0 };
  const c = (poste: string, entree: number, sortie: number, n = 1) => (n * (entree * prix(poste).entree + sortie * prix(poste).sortie)) / 1e6;
  const renforce = produitPhare && r.modeRenforce;
  const passages = renforce ? 2 : r.passages;
  const nbE = r.nbCasEntrainement;
  const nbC = r.nbCasControle;
  const reponsesPanel = (3 * nbE + nbC) * passages;
  const evaluateur = renforce ? 'evaluateur_renforce' : 'evaluateur';
  return (
    c('cadreur', 3000, 10000) +
    c('documentaliste', 3000, 3000) +
    c('redacteur1', 8500, 6000) + c('redacteur2', 8500, 6000) + c('redacteur3', 8500, 6000) +
    c('redacteur1', 6000, 1500) + c('redacteur2', 6000, 1500) + c('redacteur3', 6000, 1500) +
    c('panel_avance', 2100, 500, reponsesPanel + 6) +
    c('panel_leger', 2100, 500, reponsesPanel + 6) +
    c(evaluateur, 4000, 1000, (nbE + nbC) * passages) +
    c('juge', 18000, 9000) +
    c('livrables', 3000, 2000)
  );
}
