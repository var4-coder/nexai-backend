import type { Cas, Critere } from '@/services/atelier-skills/schemas';

/**
 * Notation de l'Atelier Skills — avenant v1.3 §5. TOUT est calculé par le
 * code : contrôles mécaniques, score de chaque réponse, note sur 100,
 * classement, vetos du code, verdict et alertes. Aucune IA ne décide d'un
 * classement ni d'un verdict. Fonctions pures, testables à part.
 */

// ─── Outils texte ─────────────────────────────────────────────────────────

export function sansAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function compterMots(s: string): number {
  return (s.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** En-tête YAML (name, description) et corps d'un SKILL.md. */
export function lireSkillMd(skillMd: string): { name: string; description: string; corps: string } {
  const m = skillMd.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', corps: skillMd.trim() };
  const yaml = m[1];
  const champ = (cle: string) => {
    const l = yaml.match(new RegExp(`^${cle}\\s*:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    return l.replace(/^["']|["']$/g, '').trim();
  };
  return { name: champ('name'), description: champ('description'), corps: m[2].trim() };
}

/** Montants (nombre + devise, devise + nombre) et pourcentages d'un texte. */
export function montants(texte: string): { brut: string; nombre: string; devise: string | null }[] {
  const sortie: { brut: string; nombre: string; devise: string | null }[] = [];
  const reApres = /(\d[\d\s.,]*\d|\d)\s?(fcfa|f\s?cfa|cfa|xof|xaf|€|eur(?:os?)?|\$|usd|dollars?|francs?|ghs|cedis?|ngn|naira|mad|dirhams?|kes|shillings?|gnf|cdf|%)(?![\p{L}])/giu;
  const reAvant = /(\$|€|usd|eur)\s?(\d[\d\s.,]*\d|\d)/gi;
  for (const m of texte.matchAll(reApres)) sortie.push({ brut: m[0], nombre: m[1].replace(/[\s.,]/g, ''), devise: m[2] === '%' ? '%' : m[2] });
  for (const m of texte.matchAll(reAvant)) sortie.push({ brut: m[0], nombre: m[2].replace(/[\s.,]/g, ''), devise: m[1] });
  return sortie;
}

function normaliserDevise(d: string | null): string {
  const v = sansAccents(d ?? '').replace(/\s/g, '');
  if (/^(fcfa|cfa|xof|xaf|francs?)$/.test(v)) return 'fcfa';
  if (/^(€|eur|euros?)$/.test(v)) return 'eur';
  if (/^(\$|usd|dollars?)$/.test(v)) return 'usd';
  if (/^(ghs|cedis?)$/.test(v)) return 'ghs';
  if (/^(ngn|naira)$/.test(v)) return 'ngn';
  if (/^(mad|dirhams?)$/.test(v)) return 'mad';
  return v;
}

const MOTS_FR = ['le', 'la', 'les', 'de', 'des', 'et', 'un', 'une', 'vous', 'pour', 'est', 'que', 'en', 'du', 'avec', 'votre', 'nous', 'je', 'pas', 'sur'];
const MOTS_EN = ['the', 'and', 'you', 'for', 'is', 'of', 'to', 'your', 'with', 'this', 'that', 'are', 'we', 'not'];

export function estDansLaLangue(texte: string, langue: string): boolean {
  const mots = sansAccents(texte).match(/[a-z]+/g) ?? [];
  if (mots.length < 8) return true;
  const fr = mots.filter((m) => MOTS_FR.includes(m)).length;
  const en = mots.filter((m) => MOTS_EN.includes(m)).length;
  const l = sansAccents(langue).slice(0, 2);
  if (l === 'fr') return fr >= 2 && fr >= en;
  if (l === 'en') return en >= 2 && en >= fr;
  return true; // langue non gérée par le contrôle : jamais refusée pour cette seule raison
}

// ─── Contrôles mécaniques (critères de type « code ») ─────────────────────

/** true / false si le code sait vérifier le critère ; null sinon (noté par l'évaluateur). */
export function controleCode(c: Critere, reponse: string, contexte: { message: string; faitsAutorises: string }): boolean | null {
  if (c.type !== 'code' || !c.controle) return null;
  const v = c.controle.valeur;
  const liste = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const r = sansAccents(reponse);
  switch (c.controle.type) {
    case 'mots_max':
      return typeof v === 'number' ? compterMots(reponse) <= v : null;
    case 'mots_min':
      return typeof v === 'number' ? compterMots(reponse) >= v : null;
    case 'contient_question':
      return /\?/.test(reponse);
    case 'sans_question':
      return !/\?/.test(reponse);
    case 'aucun_montant_non_fourni': {
      const source = `${contexte.message}\n${contexte.faitsAutorises}`.replace(/[\s.,]/g, '');
      return montants(reponse).every((m) => source.includes(m.nombre));
    }
    case 'langue':
      return typeof v === 'string' ? estDansLaLangue(reponse, v) : null;
    case 'contient':
      return liste.length ? liste.some((mot) => r.includes(sansAccents(mot))) : null;
    case 'ne_contient_pas':
      return liste.length ? liste.every((mot) => !r.includes(sansAccents(mot))) : null;
    case 'devise': {
      if (typeof v !== 'string') return null;
      const attendue = normaliserDevise(v);
      return montants(reponse)
        .filter((m) => m.devise !== '%')
        .every((m) => normaliserDevise(m.devise) === attendue);
    }
    default:
      return null;
  }
}

/** Critères laissés à l'évaluateur : type juge, ou code sans contrôle vérifiable. */
export function criteresPourEvaluateur(cas: Cas, reponse = ''): Critere[] {
  return cas.criteres.filter((c) => controleCode(c, reponse, { message: '', faitsAutorises: '' }) === null);
}

// ─── Score d'une réponse ──────────────────────────────────────────────────

export interface ScoreReponse {
  score: number;
  terrain: number | null;
  /** Respect du (des) critère(s) de longueur du cadreur ; null si aucun. */
  longueurOk: boolean | null;
  invention: boolean;
  /** Critères ratés (pour les preuves de l'auto-critique et de la fusion). */
  rates: string[];
}

function valeurNormalisee(c: Critere, valeur: unknown): number {
  if (c.mesure === '0_5') {
    const n = typeof valeur === 'number' ? valeur : Number(String(valeur).replace(',', '.'));
    return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) / 5 : 0;
  }
  if (typeof valeur === 'boolean') return valeur ? 1 : 0;
  return /^(oui|yes|true|1)$/i.test(String(valeur).trim()) ? 1 : 0;
}

/**
 * Score (0 à 1) = points obtenus / points possibles, chaque critère pesant 1.
 * Une réponse avec invention vaut 0. Un critère de l'évaluateur absent de sa
 * notation compte 0 (« un doute vaut non »).
 */
export function scorerReponse(
  cas: Cas,
  reponse: string,
  notesEvaluateur: Map<string, unknown>,
  invention: boolean,
  contexte: { message: string; faitsAutorises: string }
): ScoreReponse {
  let total = 0;
  const terrains: number[] = [];
  const longueurs: boolean[] = [];
  const rates: string[] = [];
  for (const c of cas.criteres) {
    const parCode = controleCode(c, reponse, contexte);
    const v = parCode !== null ? (parCode ? 1 : 0) : valeurNormalisee(c, notesEvaluateur.get(c.id));
    total += v;
    if (v < 1) rates.push(c.id);
    if (c.terrain) terrains.push(v);
    if (c.controle?.type === 'mots_max' && parCode !== null) longueurs.push(parCode);
  }
  const score = invention ? 0 : cas.criteres.length ? total / cas.criteres.length : 0;
  return {
    score,
    terrain: terrains.length ? (invention ? 0 : terrains.reduce((a, b) => a + b, 0) / terrains.length) : null,
    longueurOk: longueurs.length ? longueurs.every(Boolean) : null,
    invention,
    rates,
  };
}

// ─── Note sur 100 ─────────────────────────────────────────────────────────

export interface ReponseNotee extends ScoreReponse {
  casId: string;
  casType: Cas['type'];
  niveau: 'avance' | 'leger';
}

const moyenne = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface DetailNote {
  total: number;
  reussite: number;
  leger: number;
  robustesse: number;
  terrain: number;
  concision: number;
  moyenneAvance: number;
  moyenneLeger: number;
  ecart: number;
  scoreMoyen: number;
  alertes: string[];
}

export function noteSur100(reponses: ReponseNotee[], motsCorps: number): DetailNote {
  const alertes: string[] = [];
  const tous = reponses.map((r) => r.score);
  const legers = reponses.filter((r) => r.niveau === 'leger').map((r) => r.score);
  const avances = reponses.filter((r) => r.niveau === 'avance').map((r) => r.score);
  const robustes = reponses.filter((r) => r.casType === 'incomplet' || r.casType === 'piege').map((r) => r.score);
  const terrains = reponses.map((r) => r.terrain).filter((t): t is number => t !== null);
  const longueurs = reponses.map((r) => r.longueurOk).filter((l): l is boolean => l !== null);
  if (terrains.length === 0) alertes.push('Aucun critère « terrain » noté : point Terrain calculé sur la réussite générale.');
  if (longueurs.length === 0) alertes.push('Aucun critère de longueur du cadreur : part de concision comptée à 100 %.');

  const reussite = 40 * moyenne(tous);
  const leger = 20 * moyenne(legers);
  const robustesse = 20 * (robustes.length ? moyenne(robustes) : moyenne(tous));
  const terrain = 10 * (terrains.length ? moyenne(terrains) : moyenne(tous));
  const partLongueur = longueurs.length ? longueurs.filter(Boolean).length / longueurs.length : 1;
  const concision = (motsCorps >= 400 && motsCorps <= 900 ? 5 : 0) + 5 * partLongueur;
  const total = Math.round((reussite + leger + robustesse + terrain + concision) * 10) / 10;
  return {
    total,
    reussite,
    leger,
    robustesse,
    terrain,
    concision,
    moyenneAvance: moyenne(avances),
    moyenneLeger: moyenne(legers),
    ecart: moyenne(avances) - moyenne(legers),
    scoreMoyen: moyenne(tous),
    alertes,
  };
}

// ─── Classement des versions (étape 3) ────────────────────────────────────

export interface VersionClassee {
  version: string;
  note: number;
  ecart: number;
  longueur: number;
}

/**
 * La meilleure note l'emporte. Égalité (écart < `egalite` points) : plus
 * petit écart avancé/léger, puis texte le plus court.
 */
export function classerVersions(versions: VersionClassee[], egalite: number): VersionClassee[] {
  return [...versions].sort((a, b) => {
    if (Math.abs(a.note - b.note) >= egalite) return b.note - a.note;
    if (Math.abs(a.ecart - b.ecart) > 1e-9) return Math.abs(a.ecart) - Math.abs(b.ecart);
    return a.longueur - b.longueur;
  });
}

// ─── Vetos du code, verdict ───────────────────────────────────────────────

/** Veto « Échec sur plus d'un quart des cas de contrôle » (cas échoué = score moyen < seuil). */
export function vetoControle(reponses: ReponseNotee[], seuilCas: number): { present: boolean; casEchoues: string[] } {
  const parCas = new Map<string, number[]>();
  for (const r of reponses) parCas.set(r.casId, [...(parCas.get(r.casId) ?? []), r.score]);
  const casEchoues = [...parCas.entries()].filter(([, s]) => moyenne(s) < seuilCas).map(([id]) => id);
  return { present: parCas.size > 0 && casEchoues.length > parCas.size / 4, casEchoues };
}

export function decider(params: {
  vetos: { present: boolean }[];
  noteFinale: number;
  scoreControle: number;
  scoreEntrainementGagnant: number;
  declenchement: { correctes: number; total: number };
  seuils: { note: number; controlePct: number; declenchementMin: number };
  relances: number;
}): { verdict: 'publie' | 'a_retravailler' | 'ecarte'; raisons: string[] } {
  const raisons: string[] = [];
  if (params.vetos.some((v) => v.present)) raisons.push('veto présent');
  if (params.noteFinale < params.seuils.note) raisons.push(`note finale ${params.noteFinale} < ${params.seuils.note}`);
  const seuilControle = (params.seuils.controlePct / 100) * params.scoreEntrainementGagnant;
  if (params.scoreControle < seuilControle) {
    raisons.push(`score de contrôle ${params.scoreControle.toFixed(2)} < ${params.seuils.controlePct} % de l'entraînement (${seuilControle.toFixed(2)})`);
  }
  if (params.declenchement.correctes < params.seuils.declenchementMin) {
    raisons.push(`déclenchement ${params.declenchement.correctes}/${params.declenchement.total} < ${params.seuils.declenchementMin}`);
  }
  if (raisons.length === 0) return { verdict: 'publie', raisons };
  return { verdict: params.relances >= 1 ? 'ecarte' : 'a_retravailler', raisons };
}

// ─── Scan « à relire » (étape 4c) ─────────────────────────────────────────

const MOTS_PROMESSE = ['garanti', 'garantie', 'garantis', 'assure', 'assuree', 'sans risque', '100 %', '100%', 'guerison', 'guerir', 'devenir riche', 'doubler vos', 'tripler vos', 'succes assure', 'resultat certain'];
const MOTS_COURANTS = new Set(['Skill', 'Rôle', 'Informations', 'Étapes', 'Règles', 'Format', 'Exemple', 'Exemples', 'Erreurs', 'Si', 'Le', 'La', 'Les', 'Un', 'Une', 'Pour', 'Ne', 'Vous', 'Je', 'Tu', 'Il', 'Elle', 'Nous', 'Toujours', 'Jamais', 'Réponse', 'Question', 'Client', 'WhatsApp', 'Mobile', 'Money', 'FCFA', 'Afrique', 'NexAI']);

/**
 * Alerte « à relire » (pas un veto) : montants et pourcentages absents des
 * faits déclarés, mots de promesse, noms propres absents des faits.
 */
export function scanARelire(corps: string, faitsUtilises: unknown[]): string[] {
  const faits = JSON.stringify(faitsUtilises ?? []);
  const faitsChiffres = faits.replace(/[\s.,]/g, '');
  const alertes: string[] = [];
  for (const m of montants(corps)) {
    if (!faitsChiffres.includes(m.nombre)) alertes.push(`Montant ou pourcentage hors faits déclarés : « ${m.brut.trim()} »`);
  }
  const s = sansAccents(corps);
  for (const mot of MOTS_PROMESSE) if (s.includes(mot)) alertes.push(`Mot de promesse : « ${mot} »`);
  const noms = new Set<string>();
  for (const ligne of corps.split('\n')) {
    const mots = ligne.replace(/^[\s#>*\-\d.)]+/, '').split(/\s+/);
    for (let i = 1; i < mots.length; i++) {
      // Un mot qui suit une fin de phrase (. : ! ? «) commence normalement par une majuscule : ignoré.
      if (/[.:!?«(]$/.test(mots[i - 1])) continue;
      const propre = mots[i].replace(/[^\p{L}'’-]/gu, '');
      if (propre.length >= 3 && /^\p{Lu}[\p{Ll}]/u.test(propre) && !MOTS_COURANTS.has(propre) && !faits.includes(propre)) noms.add(propre);
    }
  }
  for (const n of [...noms].slice(0, 8)) alertes.push(`Nom propre hors faits déclarés : « ${n} »`);
  return Array.from(new Set(alertes)).slice(0, 25);
}
