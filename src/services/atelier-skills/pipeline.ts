import type { HydratedDocument } from 'mongoose';
import type { z } from 'zod';
import { pipelineQueue } from '@/jobs/queue';
import { AppError } from '@/middleware/errorHandler';
import {
  ETAPES_SKILL,
  Skill,
  SkillGrid,
  SkillRequest,
  SkillRun,
  SkillTestCase,
  type EtapeSkill,
  type IEtapeRun,
  type ISkillRequest,
  type ISkillRun,
  type ISkillSettings,
} from '@/models/AtelierSkills';
import { appelerModeleBrut, coutAppel, extraireJson } from '@/services/atelier-skills/modeles';
import { compterAppelIaUsd } from '@/services/stats-jour.service';
import { consigne, GRILLE_V0, vetosDuJuge } from '@/services/atelier-skills/consignes';
import { decoderPrix, encoderPrix, lireReglages } from '@/services/atelier-skills/reglages';
import { BUDGET_MINI_RELANCE_USD, POSTES_COMMANDE_CLIENT } from '@/services/atelier-skills/commandes-client';
import {
  autoCritiqueSchema,
  cadrageSchema,
  dossierSchema,
  fusionSchema,
  livrablesSchema,
  notationSchema,
  propositionSchema,
  type Cadrage,
  type Cas,
  type Dossier,
  type Fusion,
  type Proposition,
} from '@/services/atelier-skills/schemas';
import {
  classerVersions,
  compterMots,
  criteresPourEvaluateur,
  decider,
  lireSkillMd,
  noteSur100,
  scanARelire,
  scorerReponse,
  vetoControle,
  type ReponseNotee,
} from '@/services/atelier-skills/notation';
import {
  assemblerSkillMd,
  assemblerVersionACollee,
  consigneDeTest,
  ficheProduitTexte,
  guidePdf,
  preuvePdf,
  texteResumePreuve,
  zipDuSkill,
} from '@/services/atelier-skills/livrables';

/**
 * PIPELINE DE L'ATELIER SKILLS — avenant v1.3 (5 étapes affichées, 7 tâches).
 *
 *  1. skill_cadrage + skill_dossier      — cadreur, puis documentaliste (recherche web + X)
 *  2. skill_propositions                 — 3 rédacteurs à l'aveugle, en parallèle
 *  3. skill_tests                        — panel (avancé + léger) × 8 cas, évaluateur aveugle, classement par le code
 *  4. skill_fusion                       — auto-critique des 3 rédacteurs, puis fusion + vetos (1 appel)
 *  5. skill_controle + skill_livrables   — contrôle final, déclenchement, verdict du code, fichiers
 *
 * Chaque tâche est un job du worker existant (file « pipeline »). Chaque
 * sortie est enregistrée en base : une exécution interrompue reprend à
 * l'étape en échec. Un appel qui échoue ou rend un JSON invalide est
 * retenté 2 fois. Plafond atteint : arrêt propre, statut « plafond_atteint »,
 * reprenable.
 */

class PlafondAtteint extends Error {}

type Config = Pick<ISkillSettings, 'postes' | 'seuils' | 'plafondUSD' | 'nbCasEntrainement' | 'nbCasControle' | 'passages' | 'modeRenforce' | 'prix' | 'consignes'> & {
  grilleVersion: number;
  grilleContenu: string;
  renforce: boolean;
};

interface Ctx {
  run: HydratedDocument<ISkillRun>;
  request: ISkillRequest;
  config: Config;
  etape: IEtapeRun;
}

// ─── Outils ───────────────────────────────────────────────────────────────

function melanger<T>(liste: T[]): T[] {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Exécute des tâches avec une concurrence bornée (les fournisseurs limitent le débit). */
async function enParallele<T>(taches: (() => Promise<T>)[], limite = 6): Promise<T[]> {
  const resultats: T[] = new Array(taches.length);
  let suivant = 0;
  const travailleurs = Array.from({ length: Math.min(limite, taches.length) }, async () => {
    while (suivant < taches.length) {
      const i = suivant++;
      resultats[i] = await taches[i]();
    }
  });
  await Promise.all(travailleurs);
  return resultats;
}

function etapeDe(run: ISkillRun, nom: EtapeSkill): IEtapeRun {
  const e = run.etapes.find((x) => x.nom === nom);
  if (!e) throw new Error(`Étape ${nom} absente`);
  return e;
}

function sortieDe<T>(run: ISkillRun, nom: EtapeSkill): T {
  const s = etapeDe(run, nom).sortie;
  if (s === undefined || s === null) throw new AppError(`Sortie de l'étape ${nom} absente (exécution purgée ?).`, 409);
  return s as T;
}

/**
 * Appel d'un poste : plafond contrôlé AVANT l'appel, 1 + 2 tentatives,
 * sortie JSON validée par schéma, coût réel ajouté à l'étape et à l'exécution.
 */
async function appeler<S extends z.ZodTypeAny | null>(
  ctx: Ctx,
  poste: string,
  systeme: string,
  message: string,
  opts: { schema: S; maxTokens: number; recherche?: boolean; valider?: (v: unknown) => string | null; modele?: string }
): Promise<S extends z.ZodTypeAny ? z.infer<S> : string> {
  const reglage = ctx.config.postes[poste];
  const modele = opts.modele ?? reglage?.modele;
  if (!modele) throw new Error(`Poste ${poste} non réglé`);
  let derniere: unknown = null;
  for (let tentative = 1; tentative <= 3; tentative++) {
    if (ctx.run.coutTotalUSD >= ctx.config.plafondUSD) throw new PlafondAtteint();
    const debut = Date.now();
    try {
      const r = await appelerModeleBrut({
        modele,
        systeme,
        message,
        maxTokens: opts.maxTokens,
        effort: reglage?.effort,
        json: !!opts.schema,
        recherche: opts.recherche,
      });
      const cout = coutAppel(ctx.config.prix[modele], r);
      // Coût IA du jour pour le Bilan (Anthropic, xAI, OpenAI, DeepSeek).
      compterAppelIaUsd(modele, cout, r.entree + r.cache, r.sortie);
      ctx.etape.appels.push({ poste, modele, entree: r.entree, sortie: r.sortie, cache: r.cache, coutUSD: cout, dureeMs: Date.now() - debut, tentatives: tentative });
      ctx.etape.jetons += r.entree + r.sortie + r.cache;
      ctx.etape.coutUSD += cout;
      ctx.run.coutTotalUSD += cout;
      if (!opts.schema) return r.texte.trim() as never;
      const objet = (opts.schema as z.ZodTypeAny).parse(extraireJson(r.texte));
      const refus = opts.valider?.(objet);
      if (refus) throw new Error(`Sortie refusée par le contrôle du code : ${refus}`);
      return objet as never;
    } catch (err) {
      if (err instanceof PlafondAtteint) throw err;
      derniere = err;
      // Métadonnées seulement (cahier v1 §9.5) : jamais le contenu de l'échange.
      ctx.etape.appels.push({ poste, modele, entree: 0, sortie: 0, cache: 0, coutUSD: 0, dureeMs: Date.now() - debut, tentatives: tentative, erreur: String((err as Error).message).slice(0, 200) });
      console.warn(`[atelier-skills] ${poste} (${modele}) tentative ${tentative}/3 échouée — ${String((err as Error).message).slice(0, 160)}`);
    }
  }
  throw new Error(`Poste ${poste} : échec après 3 tentatives — ${String((derniere as Error)?.message).slice(0, 200)}`);
}

function entete(ctx: Ctx): string {
  return consigne('ENTETE_FIABILITE', ctx.config.consignes);
}

function cadrageDe(run: ISkillRun): Cadrage {
  return sortieDe<{ cadrage: Cadrage }>(run, 'skill_cadrage').cadrage;
}

async function casDuRun(runId: unknown, type: string): Promise<Cas[]> {
  const docs = await SkillTestCase.find({ runId, type }).sort({ createdAt: 1 }).lean();
  return docs.map((d) => d.contenu as Cas);
}

/** Faits autorisés pour l'évaluateur : faits déclarés par les rédacteurs (v1.2, point 7). */
function faitsAutorises(versions: { faits_utilises: unknown[] }[]): string {
  return JSON.stringify(versions.flatMap((v) => v.faits_utilises ?? [])).slice(0, 6000);
}

// ─── Panel et évaluateur (étapes 3 et 5) ──────────────────────────────────

interface Sortie {
  version: string;
  casId: string;
  niveau: 'avance' | 'leger';
  passage: number;
  texte: string;
}

interface SortieNotee extends Sortie, ReponseNotee {
  notes?: { id: string; valeur: unknown; justification?: string | null }[];
}

async function executerPanel(
  ctx: Ctx,
  versions: Record<string, { skill_md: string; references: { nom: string; contenu: string }[] }>,
  cas: Cas[]
): Promise<Sortie[]> {
  const passages = ctx.config.renforce ? 2 : ctx.config.passages;
  const taches: (() => Promise<Sortie>)[] = [];
  for (const [version, v] of Object.entries(versions)) {
    // P7 : consigne système = 15 règles + corps sans YAML + références ; message = le cas, mot pour mot.
    const systeme = consigneDeTest(v.skill_md, entete(ctx), v.references);
    for (const c of cas) {
      for (const niveau of ['avance', 'leger'] as const) {
        for (let passage = 1; passage <= passages; passage++) {
          taches.push(async () => ({
            version,
            casId: c.id,
            niveau,
            passage,
            texte: await appeler(ctx, niveau === 'avance' ? 'panel_avance' : 'panel_leger', systeme, c.message_utilisateur, {
              schema: null,
              maxTokens: 2000,
            }),
          }));
        }
      }
    }
  }
  return enParallele(taches, 8);
}

/** Évaluateur aveugle : un appel par cas, toutes les sorties du cas mélangées (« Sortie 1… n »). */
async function noterSorties(ctx: Ctx, cas: Cas[], sorties: Sortie[], faits: string): Promise<SortieNotee[]> {
  const poste = ctx.config.renforce ? 'evaluateur_renforce' : 'evaluateur';
  const systeme = consigne('P9', ctx.config.consignes);
  const resultats: SortieNotee[] = [];
  await enParallele(
    cas.map((c) => async () => {
      const duCas = melanger(sorties.filter((s) => s.casId === c.id));
      const criteresJuge = criteresPourEvaluateur(c);
      const notesParSortie = new Map<number, { valeurs: Map<string, unknown>; invention: boolean; brut: { id: string; valeur: unknown; justification?: string | null }[] }>();
      if (criteresJuge.length > 0 || duCas.length > 0) {
        const message = JSON.stringify({
          cas_id: c.id,
          demande: c.message_utilisateur,
          comportement_attendu: c.comportement_attendu,
          criteres: criteresJuge.map((k) => ({ id: k.id, description: k.description, mesure: k.mesure })),
          faits_autorises: faits,
          sorties: duCas.map((s, i) => ({ sortie: `Sortie ${i + 1}`, texte: s.texte })),
        });
        const notation = await appeler(ctx, poste, systeme, message, {
          schema: notationSchema,
          maxTokens: 4000,
          valider: (v) => ((v as { notes: unknown[] }).notes.length === duCas.length ? null : 'nombre de sorties notées incorrect'),
        });
        for (const n of notation.notes) {
          const i = Number(String(n.sortie).replace(/\D/g, '')) - 1;
          if (i >= 0 && i < duCas.length) {
            notesParSortie.set(i, { valeurs: new Map(n.criteres.map((k) => [k.id, k.valeur])), invention: n.invention, brut: n.criteres });
          }
        }
      }
      duCas.forEach((s, i) => {
        const n = notesParSortie.get(i);
        const sc = scorerReponse(c, s.texte, n?.valeurs ?? new Map(), n?.invention ?? false, { message: c.message_utilisateur, faitsAutorises: faits });
        resultats.push({ ...s, ...sc, casId: c.id, casType: c.type, niveau: s.niveau, notes: n?.brut });
      });
    }),
    4
  );
  return resultats;
}

/** Résultats lisibles par les rédacteurs et le juge : scores par version, modèle, type de cas + sorties ratées. */
function resumeResultats(sorties: SortieNotee[], cas: Cas[], maxRatees = 12) {
  const parVersion: Record<string, Record<string, { moyenne: number; n: number }>> = {};
  for (const s of sorties) {
    const cle = `${s.niveau === 'avance' ? 'modele_avance' : 'modele_leger'}|${s.casType}`;
    parVersion[s.version] ??= {};
    const cur = parVersion[s.version][cle] ?? { moyenne: 0, n: 0 };
    cur.moyenne = (cur.moyenne * cur.n + s.score) / (cur.n + 1);
    cur.n += 1;
    parVersion[s.version][cle] = cur;
  }
  const scoresParCas = sorties.map((s) => ({ version: s.version, cas: s.casId, type: s.casType, modele: s.niveau === 'avance' ? 'avancé' : 'léger', score: Math.round(s.score * 100) / 100 }));
  const ratees = sorties
    .filter((s) => s.score < 0.5)
    .sort((a, b) => a.score - b.score)
    .slice(0, maxRatees)
    .map((s) => {
      const c = cas.find((x) => x.id === s.casId);
      return {
        version: s.version,
        cas: s.casId,
        type: s.casType,
        modele: s.niveau === 'avance' ? 'avancé' : 'léger',
        message: c?.message_utilisateur,
        criteres_rates: s.rates.map((id) => c?.criteres.find((k) => k.id === id)?.description ?? id),
        invention: s.invention,
        sortie: s.texte.slice(0, 1200),
      };
    });
  return { parVersion, scoresParCas, ratees };
}

// ─── Étapes ───────────────────────────────────────────────────────────────

async function etapeCadrage(ctx: Ctx) {
  const r = ctx.request;
  const message = JSON.stringify({
    domaine: r.domaine,
    tache: r.tache,
    public: r.public,
    langue: r.langue,
    contexte: r.contexte,
    produit_phare: r.produitPhare,
    skills_voisins: r.voisins ?? [],
  });
  const cadrage = await appeler(ctx, 'cadreur', consigne('P0', ctx.config.consignes), message, {
    schema: cadrageSchema,
    maxTokens: 16000,
    valider: (v) => {
      const c = v as Cadrage;
      const crit = c.criteres_de_succes;
      if (crit.filter((k) => k.type === 'code').length * 2 < crit.length) return 'moins de la moitié des critères sont de type code';
      if (c.cas_entrainement.length < ctx.config.nbCasEntrainement) return `${c.cas_entrainement.length} cas d'entraînement au lieu de ${ctx.config.nbCasEntrainement}`;
      if (c.cas_controle.length < ctx.config.nbCasControle * 2) return `${c.cas_controle.length} cas de contrôle au lieu de ${ctx.config.nbCasControle * 2}`;
      return null;
    },
  });

  const entrainement = cadrage.cas_entrainement.slice(0, ctx.config.nbCasEntrainement);
  const controle = cadrage.cas_controle.slice(0, ctx.config.nbCasControle);
  const reserve = cadrage.cas_controle.slice(ctx.config.nbCasControle, ctx.config.nbCasControle * 2);
  // 2 cas visibles : ceux désignés par le cadreur s'ils sont des cas normaux d'entraînement, sinon les 2 premiers normaux.
  const normaux = entrainement.filter((c) => c.type === 'normal').map((c) => c.id);
  let visibles = cadrage.cas_visibles_aux_redacteurs.filter((id) => normaux.includes(id)).slice(0, 2);
  if (visibles.length < 2) visibles = Array.from(new Set([...visibles, ...normaux])).slice(0, 2);

  await SkillTestCase.deleteMany({ runId: ctx.run._id });
  await SkillTestCase.insertMany([
    ...entrainement.map((c) => ({ runId: ctx.run._id, type: 'entrainement', casId: c.id, contenu: c, criteres: c.criteres, visibleRedacteurs: visibles.includes(c.id) })),
    ...controle.map((c) => ({ runId: ctx.run._id, type: 'controle', casId: c.id, contenu: c, criteres: c.criteres })),
    ...reserve.map((c) => ({ runId: ctx.run._id, type: 'reserve', casId: c.id, contenu: c, criteres: c.criteres })),
    ...cadrage.cas_declenchement.map((d, i) => ({ runId: ctx.run._id, type: 'declenchement', casId: `D${i + 1}`, contenu: d, criteres: [] })),
    ...cadrage.skills_distracteurs.map((d, i) => ({ runId: ctx.run._id, type: 'distracteur', casId: `X${i + 1}`, contenu: d, criteres: [] })),
  ]);
  return { cadrage: { ...cadrage, cas_visibles_aux_redacteurs: visibles } };
}

async function etapeDossier(ctx: Ctx) {
  const cadrage = cadrageDe(ctx.run);
  const r = ctx.request;
  const message = `Mode : DOSSIER\n${JSON.stringify({
    domaine: r.domaine,
    tache: r.tache,
    public: r.public,
    langue: r.langue,
    contexte: r.contexte,
    objectif: cadrage.objectif,
    risques_du_domaine: cadrage.risques_du_domaine,
    faits_a_verifier: cadrage.faits_a_verifier,
  })}`;
  const dossier = await appeler(ctx, 'documentaliste', consigne('P1', ctx.config.consignes), message, {
    schema: dossierSchema,
    maxTokens: 8000,
    recherche: true,
  });
  return { dossier };
}

const REDACTEURS = ['redacteur1', 'redacteur2', 'redacteur3'] as const;

function validerSkill(v: unknown): string | null {
  const md = (v as { skill_md: string }).skill_md;
  const { name, description, corps } = lireSkillMd(md);
  if (!name || !description) return 'en-tête YAML name/description absent';
  if (compterMots(corps) < 150) return 'corps trop court';
  return null;
}

async function etapePropositions(ctx: Ctx) {
  const cadrage = cadrageDe(ctx.run);
  const { dossier } = sortieDe<{ dossier: Dossier }>(ctx.run, 'skill_dossier');
  const visibles = (await casDuRun(ctx.run._id, 'entrainement')).filter((c) => cadrage.cas_visibles_aux_redacteurs.includes(c.id));
  const message = JSON.stringify({
    cadrage: {
      objectif: cadrage.objectif,
      utilisateur_type: cadrage.utilisateur_type,
      criteres_de_succes: cadrage.criteres_de_succes,
      risques_du_domaine: cadrage.risques_du_domaine,
      langue: ctx.request.langue,
      contexte: ctx.request.contexte,
    },
    cas_exemple: visibles.map((c) => ({ message_utilisateur: c.message_utilisateur, comportement_attendu: c.comportement_attendu })),
    dossier_de_faits: dossier,
  });
  const systeme = consigne('P2', ctx.config.consignes);
  // Anonymat : les versions sont désignées V1, V2, V3 dans un ordre tiré au hasard.
  const ordre = melanger([...REDACTEURS]);
  const correspondance: Record<string, string> = {};
  ordre.forEach((poste, i) => (correspondance[`V${i + 1}`] = poste));
  const propositions = await Promise.all(
    ordre.map((poste) => appeler(ctx, poste, systeme, message, { schema: propositionSchema, maxTokens: 16000, valider: validerSkill }))
  );
  ctx.run.correspondanceVersions = correspondance;
  const versions: Record<string, Proposition> = {};
  propositions.forEach((p, i) => (versions[`V${i + 1}`] = p));
  return { versions };
}

async function etapeTests(ctx: Ctx) {
  const { versions } = sortieDe<{ versions: Record<string, Proposition> }>(ctx.run, 'skill_propositions');
  const cas = await casDuRun(ctx.run._id, 'entrainement');
  const faits = faitsAutorises(Object.values(versions));
  const sorties = await executerPanel(ctx, versions, cas);
  const notees = await noterSorties(ctx, cas, sorties, faits);

  const notes = Object.entries(versions).map(([version, v]) => {
    const rep = notees.filter((s) => s.version === version);
    const mots = compterMots(lireSkillMd(v.skill_md).corps);
    const detail = noteSur100(rep, mots);
    const parModele = {
      avance: detail.moyenneAvance,
      leger: detail.moyenneLeger,
    };
    return { version, detail, parModele, longueur: v.skill_md.length, mots };
  });
  const classement = classerVersions(
    notes.map((n) => ({ version: n.version, note: n.detail.total, ecart: n.detail.ecart, longueur: n.longueur })),
    ctx.config.seuils.egalite
  );
  const gagnant = classement[0].version;
  const noteGagnant = notes.find((n) => n.version === gagnant)!;

  const alertes: string[] = [];
  for (const n of notes) {
    if (n.detail.ecart > ctx.config.seuils.ecartAvanceLeger) {
      alertes.push(`${n.version} : écart avancé/léger ${n.detail.ecart.toFixed(2)} > ${ctx.config.seuils.ecartAvanceLeger}`);
    }
  }
  // Ex aequo compris : le gagnant est « le meilleur » sur un modèle s'il y atteint le maximum.
  const maxAvance = Math.max(...notes.map((n) => n.parModele.avance));
  const maxLeger = Math.max(...notes.map((n) => n.parModele.leger));
  const g = notes.find((n) => n.version === gagnant)!;
  if (g.parModele.avance < maxAvance - 1e-9 && g.parModele.leger < maxLeger - 1e-9) {
    alertes.push('Dépendant du modèle : le gagnant n’est le meilleur sur aucun des 2 modèles.');
  }
  alertes.push(...noteGagnant.detail.alertes);

  ctx.run.versionBase = gagnant;
  ctx.run.noteClassement = noteGagnant.detail.total;
  ctx.run.scoreEntrainementGagnant = noteGagnant.detail.scoreMoyen;
  ctx.run.alertes = Array.from(new Set([...(ctx.run.alertes ?? []), ...alertes]));
  return {
    notes: notes.map((n) => ({ version: n.version, note: n.detail.total, detail: n.detail, mots: n.mots })),
    classement,
    gagnant,
    sorties: notees,
  };
}

async function etapeFusion(ctx: Ctx) {
  const { versions } = sortieDe<{ versions: Record<string, Proposition> }>(ctx.run, 'skill_propositions');
  const tests = sortieDe<{ gagnant: string; sorties: SortieNotee[]; notes: { version: string; note: number }[] }>(ctx.run, 'skill_tests');
  const cas = await casDuRun(ctx.run._id, 'entrainement');
  const resultats = resumeResultats(tests.sorties, cas);

  // Relance après « à retravailler » : la version finale devient la version de
  // base, et les échecs du contrôle précédent servent de preuves.
  const relance = ctx.run.relances >= 1 && !!ctx.run.versionFinale;
  const precedentControle = relance ? (etapeDe(ctx.run, 'skill_controle').sortie as { echecs?: unknown[] } | undefined) : undefined;
  const base = relance
    ? { skill_md: ctx.run.versionFinale!.skillMd, references: ctx.run.versionFinale!.references }
    : { skill_md: versions[tests.gagnant].skill_md, references: versions[tests.gagnant].references };
  const echecsControle = relance ? precedentControle?.echecs ?? [] : [];

  // 4a. Auto-critique : les 3 rédacteurs, chacun seul.
  const messageCritique = JSON.stringify({
    version_de_base: base.skill_md,
    resultats_des_3_versions: { notes: tests.notes, par_version: resultats.parVersion, scores_par_cas: resultats.scoresParCas },
    sorties_ratees: resultats.ratees,
    ...(relance ? { echecs_du_controle_final: echecsControle } : {}),
  });
  const critiques = await Promise.all(
    REDACTEURS.map((poste) => appeler(ctx, poste, consigne('P6', ctx.config.consignes), messageCritique, { schema: autoCritiqueSchema, maxTokens: 6000 }))
  );

  // 4b. Fusion + vetos, UN appel au juge-assembleur.
  const vetos = vetosDuJuge(ctx.config.grilleContenu);
  const messageFusion = JSON.stringify({
    versions: Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, { skill_md: v.skill_md, references: v.references }])),
    version_de_base: relance ? 'version finale précédente (ci-dessous)' : tests.gagnant,
    ...(relance ? { texte_version_de_base: base.skill_md } : {}),
    resultats: { notes: tests.notes, par_version: resultats.parVersion, scores_par_cas: resultats.scoresParCas },
    sorties_ratees: resultats.ratees,
    ...(relance ? { echecs_du_controle_final: echecsControle } : {}),
    changements_auto_critique: critiques.map((c, i) => ({ relecteur: `Relecteur ${String.fromCharCode(65 + i)}`, ...c })),
    faits_autorises: Object.values(versions).flatMap((v) => v.faits_utilises ?? []),
    vetos: vetos.map((v) => ({ id: v.id, description: v.texte })),
  });
  const fusion: Fusion = await appeler(ctx, 'juge', consigne('P5', ctx.config.consignes), messageFusion, {
    schema: fusionSchema,
    maxTokens: 16000,
    valider: (v) => {
      // 4c. Contrôle du code : corps de 400 à 900 mots, en-tête présent.
      const md = (v as Fusion).skill_md;
      const { name, description, corps } = lireSkillMd(md);
      if (!name || !description) return 'en-tête YAML name/description absent';
      const mots = compterMots(corps);
      if (mots < 400 || mots > 900) return `corps de ${mots} mots (attendu : 400 à 900)`;
      return null;
    },
  });

  const scan = scanARelire(lireSkillMd(fusion.skill_md).corps, fusion.faits_utilises);
  ctx.run.versionFinale = { skillMd: fusion.skill_md, references: fusion.references, faitsUtilises: fusion.faits_utilises };
  ctx.run.vetos = fusion.vetos.map((v) => ({ id: v.id, present: v.present, justification: v.justification, source: 'juge' as const }));

  // Alerte d'affinité : le modèle du juge est aussi celui d'un rédacteur et
  // plus de X % des modifications viennent de sa version, 3 exécutions de suite.
  const parts: Record<string, number> = {};
  for (const j of fusion.journal_des_modifications) {
    const src = String(j.version_source ?? '').toUpperCase();
    if (/^V[123]$/.test(src)) parts[src] = (parts[src] ?? 0) + 1;
  }
  const totalModifs = Object.values(parts).reduce((a, b) => a + b, 0);
  const dominante = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  const modeleJuge = ctx.config.postes.juge?.modele;
  const posteDominant = dominante ? ctx.run.correspondanceVersions?.[dominante[0]] : undefined;
  const affinite = {
    memeModele: !!posteDominant && ctx.config.postes[posteDominant]?.modele === modeleJuge,
    part: dominante && totalModifs ? (dominante[1] / totalModifs) * 100 : 0,
  };
  const alertes = scan.map((a) => `À relire — ${a}`);
  if (affinite.memeModele && affinite.part > ctx.config.seuils.affinite) {
    const precedents = await SkillRun.find({ _id: { $ne: ctx.run._id }, statut: 'termine' }).sort({ createdAt: -1 }).limit(2).lean();
    const suite = precedents.filter((p) => {
      const s = p.etapes?.find((e) => e.nom === 'skill_fusion')?.sortie as { affinite?: { memeModele: boolean; part: number } } | undefined;
      return s?.affinite?.memeModele && s.affinite.part > ctx.config.seuils.affinite;
    }).length;
    if (suite >= 2) alertes.push(`Affinité : plus de ${ctx.config.seuils.affinite} % des modifications viennent de la version écrite par le même modèle que le juge, 3 exécutions de suite.`);
  }
  ctx.run.alertes = Array.from(new Set([...(ctx.run.alertes ?? []), ...alertes]));
  return { autoCritiques: critiques, fusion, scan, affinite, relance };
}

async function etapeControle(ctx: Ctx) {
  const finale = ctx.run.versionFinale;
  if (!finale) throw new AppError('Version finale absente', 409);
  const relance = ctx.run.relances >= 1;
  // Relance : les 4 cas de réserve servent de contrôle final (les anciens sont « grillés »).
  const cas = await casDuRun(ctx.run._id, relance ? 'reserve' : 'controle');
  const versionsFaits = [{ faits_utilises: finale.faitsUtilises ?? [] }];
  const faits = faitsAutorises(versionsFaits);
  const sorties = await executerPanel(ctx, { FINALE: { skill_md: finale.skillMd, references: finale.references } }, cas);
  const notees = await noterSorties(ctx, cas, sorties, faits);
  const mots = compterMots(lireSkillMd(finale.skillMd).corps);
  const detail = noteSur100(notees, mots);

  // Test de déclenchement : 6 demandes × 2 modèles. Liste de 5 skills = la
  // version finale + 4 pris d'abord parmi les voisins, puis les distracteurs.
  const { name, description } = lireSkillMd(finale.skillMd);
  const demandes = (await SkillTestCase.find({ runId: ctx.run._id, type: 'declenchement' }).lean()).map((d) => d.contenu as { demande: string; doit_activer: boolean });
  const distracteurs = (await SkillTestCase.find({ runId: ctx.run._id, type: 'distracteur' }).lean()).map((d) => d.contenu as { nom: string; description: string });
  const autres = [...(ctx.request.voisins ?? []), ...distracteurs].filter((s) => s.nom && s.nom !== name).slice(0, 4);
  const resultatsDeclenchement = await enParallele(
    demandes.flatMap((d) =>
      (['panel_avance', 'panel_leger'] as const).map((poste) => async () => {
        const liste = melanger([{ nom: name, description }, ...autres]);
        const message = `Skills disponibles :\n${liste.map((s) => `- ${s.nom} : ${s.description}`).join('\n')}\n\nDemande de l'utilisateur : ${d.demande}`;
        const reponse = await appeler(ctx, poste, consigne('P8', ctx.config.consignes), message, { schema: null, maxTokens: 100 });
        const choisi = reponse.split('\n')[0].replace(/[`*"'.]/g, '').trim();
        const active = choisi.toLowerCase() === name.toLowerCase();
        return { demande: d.demande, doit_activer: d.doit_activer, modele: poste === 'panel_avance' ? 'avancé' : 'léger', reponse: choisi, correct: d.doit_activer ? active : !active };
      })
    ),
    6
  );
  const declenchement = { correctes: resultatsDeclenchement.filter((r) => r.correct).length, total: resultatsDeclenchement.length };

  const vetoCode = vetoControle(notees, ctx.config.seuils.casEchoue);
  const vetos = [
    ...(ctx.run.vetos ?? []).filter((v) => v.source === 'juge'),
    { id: 'V-CONTROLE', present: vetoCode.present, justification: vetoCode.casEchoues.length ? `cas échoués : ${vetoCode.casEchoues.join(', ')}` : '', source: 'code' as const },
  ];
  const scoreControle = detail.scoreMoyen;
  const decision = decider({
    vetos,
    noteFinale: detail.total,
    scoreControle,
    scoreEntrainementGagnant: ctx.run.scoreEntrainementGagnant ?? 0,
    declenchement,
    seuils: ctx.config.seuils,
    relances: ctx.run.relances,
  });

  ctx.run.vetos = vetos;
  ctx.run.noteFinale = detail.total;
  ctx.run.scoreControle = scoreControle;
  ctx.run.declenchement = declenchement;
  ctx.run.verdict = decision.verdict;
  if (detail.ecart > ctx.config.seuils.ecartAvanceLeger) {
    ctx.run.alertes = Array.from(new Set([...(ctx.run.alertes ?? []), `Version finale : écart avancé/léger ${detail.ecart.toFixed(2)} > ${ctx.config.seuils.ecartAvanceLeger}`]));
  }
  const echecs = notees
    .filter((s) => s.score < 0.5)
    .map((s) => ({ cas: s.casId, type: s.casType, modele: s.niveau === 'avance' ? 'avancé' : 'léger', criteres_rates: s.rates, sortie: s.texte.slice(0, 1200) }));
  return { sorties: notees, detail, declenchement: resultatsDeclenchement, decision, echecs, casUtilises: relance ? 'reserve' : 'controle' };
}

async function etapeLivrables(ctx: Ctx) {
  const finale = ctx.run.versionFinale;
  if (!finale) throw new AppError('Version finale absente', 409);
  const controle = sortieDe<{ sorties: SortieNotee[]; detail: { alertes: string[] } }>(ctx.run, 'skill_controle');
  const cadrage = cadrageDe(ctx.run);
  const casControle = await casDuRun(ctx.run._id, ctx.run.relances >= 1 ? 'reserve' : 'controle');
  const ent = entete(ctx);
  const md = assemblerSkillMd(finale.skillMd, ent);

  // Exemples avant/après : copiés des sorties RÉELLES du contrôle final (cas normaux les mieux notés, 2 cas différents).
  const exemplesBruts: SortieNotee[] = [];
  for (const s of [...controle.sorties].filter((x) => x.casType === 'normal').sort((a, b) => b.score - a.score)) {
    if (!exemplesBruts.some((e) => e.casId === s.casId)) exemplesBruts.push(s);
    if (exemplesBruts.length === 2) break;
  }
  const exemples = exemplesBruts.map((s) => ({ message: casControle.find((c) => c.id === s.casId)?.message_utilisateur ?? '', reponse: s.texte }));
  const limites = Array.from(
    new Set(
      controle.sorties
        .filter((s) => s.score < 1)
        .flatMap((s) => s.rates.map((id) => casControle.find((c) => c.id === s.casId)?.criteres.find((k) => k.id === id)?.description ?? ''))
        .filter(Boolean)
    )
  ).slice(0, 6);

  const textes = await appeler(
    ctx,
    'livrables',
    consigne('P12', ctx.config.consignes),
    JSON.stringify({ nom: md.nom, but: cadrage.objectif, public: ctx.request.public, langue: ctx.request.langue, exemples, limites_constatees: limites }),
    { schema: livrablesSchema, maxTokens: 5000 }
  );

  const donneesPreuve = {
    nom: md.nom,
    modelesTest: ['avancé', 'léger'],
    noteClassement: ctx.run.noteClassement ?? 0,
    noteFinale: ctx.run.noteFinale ?? 0,
    scoreControle: ctx.run.scoreControle ?? 0,
    scoreEntrainement: ctx.run.scoreEntrainementGagnant ?? 0,
    nbReponses: controle.sorties.length,
    declenchement: ctx.run.declenchement ?? { correctes: 0, total: 0 },
    vetos: (ctx.run.vetos ?? []).map((v) => ({ id: v.id, present: v.present })),
    alertes: ctx.run.alertes ?? [],
    grilleVersion: ctx.config.grilleVersion,
    date: new Date(),
  };
  const [guide, preuve] = await Promise.all([
    guidePdf({
      titre: textes.guide.titre,
      introduction: textes.guide.introduction,
      exemples: exemples.map((e, i) => ({ intro: i === 0 ? textes.guide.intro_exemple_1 : textes.guide.intro_exemple_2, ...e })),
      installation: textes.guide.installation,
      limites: textes.guide.limites,
      preuveResume: texteResumePreuve(donneesPreuve),
    }),
    preuvePdf(donneesPreuve),
  ]);

  const fichiers = {
    skillMd: md.skillMd,
    references: finale.references,
    aColler: assemblerVersionACollee(md.corps, ent, finale.references),
    guidePdf: guide,
    preuvePdf: preuve,
    ficheProduit: ficheProduitTexte(textes.fiche_produit),
    zip: zipDuSkill(md.nom, md.skillMd, finale.references),
  };
  const precedent = await Skill.findOne({ slug: md.nom }).sort({ version: -1 }).select('version').lean();
  const skill = await Skill.create({
    runId: ctx.run._id,
    slug: md.nom,
    nom: textes.fiche_produit.titre || md.nom,
    description: md.description,
    domaine: ctx.request.domaine,
    version: (precedent?.version ?? 0) + 1,
    fichiers,
    note: ctx.run.noteFinale,
    verdict: 'publie',
    grilleVersion: ctx.config.grilleVersion,
  });
  ctx.run.skillId = skill._id;

  // Révision de la grille : la version jugée devient une NOUVELLE grille, inactive tant que l'admin ne l'active pas.
  if (ctx.request.type === 'grille') {
    const derniere = await SkillGrid.findOne().sort({ version: -1 }).select('version').lean();
    await SkillGrid.create({ version: (derniere?.version ?? 0) + 1, contenu: md.corps, active: false, runId: ctx.run._id });
  }
  return { skillId: String(skill._id), slug: md.nom, livrables: textes };
}

const HANDLERS: Record<EtapeSkill, (ctx: Ctx) => Promise<unknown>> = {
  skill_cadrage: etapeCadrage,
  skill_dossier: etapeDossier,
  skill_propositions: etapePropositions,
  skill_tests: etapeTests,
  skill_fusion: etapeFusion,
  skill_controle: etapeControle,
  skill_livrables: etapeLivrables,
};

// ─── Orchestration ────────────────────────────────────────────────────────

/** Grille active (la v0 amorce est créée au premier besoin). */
export async function grilleActive(): Promise<{ version: number; contenu: string }> {
  const active = await SkillGrid.findOne({ active: true }).lean();
  if (active) return { version: active.version, contenu: active.contenu };
  const v0 = await SkillGrid.findOneAndUpdate(
    { version: 0 },
    { $setOnInsert: { version: 0, contenu: GRILLE_V0, active: true } },
    { upsert: true, new: true }
  ).lean();
  return { version: v0!.version, contenu: v0!.contenu };
}

async function planifier(runId: string, etape: EtapeSkill): Promise<void> {
  await pipelineQueue.add(
    'skill_etape',
    { type: 'skill_etape', siteId: '', userId: '', runId, etape },
    { jobId: `skill_${runId}_${etape}_${Date.now()}`, attempts: 1, removeOnComplete: true, removeOnFail: 200 }
  );
}

/** Délai au-delà duquel une exécution sans activité est considérée interrompue (supérieur au garde d'une étape : 30 min). */
const SKILL_INACTIVITE_MAX_MS = 31 * 60 * 1000;

/**
 * Filet anti-blocage : une exécution restée « en cours » sans activité (worker
 * redémarré par un déploiement, Redis vidé) n'avancerait jamais, et le client
 * ne verrait ni relance ni assistance. Première interruption : l'étape est
 * reprise automatiquement, une seule fois. Ensuite l'exécution passe en
 * échec, ce qui ouvre au client la relance gratuite puis l'assistance.
 * Aucun remboursement n'intervient ici.
 */
export async function recupererSkillsBloques(): Promise<number> {
  const limite = new Date(Date.now() - SKILL_INACTIVITE_MAX_MS);
  const runs = await SkillRun.find({ statut: 'en_cours', updatedAt: { $lt: limite } }).limit(20);
  let n = 0;
  for (const run of runs) {
    const etape =
      run.etapes.find((e) => e.statut === 'en_cours') ??
      run.etapes.find((e) => e.nom === run.etapeCourante) ??
      run.etapes.find((e) => e.statut === 'en_attente');
    if (!etape) continue;
    if ((run.reprisesAuto ?? 0) < 1) {
      run.reprisesAuto = 1;
      etape.statut = 'en_attente';
      run.markModified('etapes');
      await run.save();
      await planifier(String(run._id), etape.nom);
      console.warn(`[atelier-skills] Exécution ${run._id} interrompue : étape ${etape.nom} reprise automatiquement.`);
    } else {
      etape.statut = 'echec';
      etape.fin = new Date();
      etape.erreur = 'Exécution interrompue (redémarrage du service) et déjà reprise une fois.';
      run.statut = 'echec';
      run.markModified('etapes');
      await run.save();
      console.error(`[atelier-skills] Exécution ${run._id} abandonnée après interruption répétée.`);
    }
    n += 1;
  }
  return n;
}

export async function lancerExecution(requestId: string): Promise<HydratedDocument<ISkillRun>> {
  const request = await SkillRequest.findById(requestId).lean();
  if (!request) throw new AppError('Demande introuvable', 404);
  const reglages = await lireReglages();
  const grille = await grilleActive();
  const renforce = request.produitPhare && reglages.modeRenforce;
  const configuration: Config = {
    postes: request.userId ? { ...reglages.postes, ...POSTES_COMMANDE_CLIENT } : reglages.postes,
    seuils: reglages.seuils,
    plafondUSD: request.plafondUSD ?? reglages.plafondUSD,
    nbCasEntrainement: reglages.nbCasEntrainement,
    nbCasControle: reglages.nbCasControle,
    passages: reglages.passages,
    modeRenforce: reglages.modeRenforce,
    prix: reglages.prix,
    consignes: reglages.consignes,
    grilleVersion: grille.version,
    grilleContenu: grille.contenu,
    renforce,
  };
  const run = await SkillRun.create({
    requestId: request._id,
    statut: 'en_cours',
    etapeCourante: 'skill_cadrage',
    etapes: ETAPES_SKILL.map((nom) => ({ nom, statut: 'en_attente', appels: [], jetons: 0, coutUSD: 0 })),
    coutTotalUSD: 0,
    grilleVersion: grille.version,
    configuration: { ...configuration, prix: encoderPrix(configuration.prix) },
    relances: 0,
  });
  await planifier(String(run._id), 'skill_cadrage');
  return run;
}

/** Exécutée par le worker : une tâche, puis planification de la suivante. */
export async function executerEtapeSkill(runId: string, nom: EtapeSkill): Promise<void> {
  const run = await SkillRun.findById(runId);
  if (!run || run.statut !== 'en_cours') return;
  const request = await SkillRequest.findById(run.requestId).lean();
  if (!request) throw new Error('Demande introuvable');
  const etape = run.etapes.find((e) => e.nom === nom);
  if (!etape || etape.statut === 'termine' || etape.statut === 'saute') return;
  // Job en double (redémarrage du worker…) : une étape déjà en cours depuis moins de 30 min n'est pas relancée.
  if (etape.statut === 'en_cours' && etape.debut && Date.now() - new Date(etape.debut).getTime() < 30 * 60 * 1000) return;

  const stockee = run.configuration as Config;
  const config: Config = { ...stockee, prix: decoderPrix(stockee.prix) };
  etape.statut = 'en_cours';
  etape.debut = new Date();
  etape.erreur = undefined;
  etape.appels = [];
  etape.jetons = 0;
  etape.coutUSD = 0;
  run.etapeCourante = nom;
  run.markModified('etapes');
  await run.save();

  const ctx: Ctx = { run, request, config, etape };
  try {
    const sortie = await HANDLERS[nom](ctx);
    etape.sortie = sortie;
    etape.statut = 'termine';
    etape.fin = new Date();

    // Suite : après le contrôle, livrables seulement si « publié ».
    let suivante: EtapeSkill | null = ETAPES_SKILL[ETAPES_SKILL.indexOf(nom) + 1] ?? null;
    if (nom === 'skill_controle' && run.verdict !== 'publie') {
      const livr = run.etapes.find((e) => e.nom === 'skill_livrables');
      if (livr) livr.statut = 'saute';
      suivante = null;
    }
    if (!suivante) {
      run.statut = 'termine';
      run.etapeCourante = undefined;
    }
    run.markModified('etapes');
    await run.save();
    if (suivante) await planifier(runId, suivante);
    else await conclureCommandeClient(runId, request);
  } catch (err) {
    etape.fin = new Date();
    etape.statut = 'echec';
    if (err instanceof PlafondAtteint) {
      etape.erreur = `Plafond de ${config.plafondUSD} $ atteint (${run.coutTotalUSD.toFixed(2)} $).`;
      run.statut = 'plafond_atteint';
    } else {
      etape.erreur = String((err as Error).message).slice(0, 500);
      run.statut = 'echec';
    }
    run.markModified('etapes');
    await run.save();
    console.error(`[atelier-skills] Exécution ${runId} — étape ${nom} en échec : ${etape.erreur}`);
  }
}

/**
 * Fin d'exécution d'une commande CLIENT (Skill NexAI) : si le verdict est
 * « à retravailler » et que le budget restant le permet, UNE relance interne
 * automatique est tentée. Sinon rien n'est remboursé : le client voit sa
 * commande « non aboutie » et peut la relancer gratuitement après 30 minutes
 * (voir relancerCommande), puis être orienté vers l'assistance.
 */
async function conclureCommandeClient(runId: string, request: ISkillRequest): Promise<void> {
  if (!request.userId) return;
  try {
    const run = await SkillRun.findById(runId);
    if (!run || run.statut !== 'termine' || run.verdict !== 'a_retravailler') return;
    const plafond = (run.configuration as Config | undefined)?.plafondUSD ?? 0;
    if (run.relances < 1 && !run.purge && plafond - run.coutTotalUSD >= BUDGET_MINI_RELANCE_USD) {
      await relancerExecution(runId);
    }
  } catch (err) {
    console.error(`[atelier-skills] Conclusion de la commande client ${runId} en erreur :`, (err as Error).message);
  }
}

/** Reprend depuis l'étape en échec (le plafond est relu dans les réglages actuels). */
export async function reprendreExecution(runId: string): Promise<void> {
  const run = await SkillRun.findById(runId);
  if (!run) throw new AppError('Exécution introuvable', 404);
  if (run.statut !== 'echec' && run.statut !== 'plafond_atteint') throw new AppError('Seule une exécution en échec ou au plafond peut reprendre.', 400);
  const etape = run.etapes.find((e) => e.statut === 'echec' || e.statut === 'en_cours');
  if (!etape) throw new AppError('Aucune étape à reprendre.', 400);
  const reglages = await lireReglages();
  const demande = await SkillRequest.findById(run.requestId).select('plafondUSD').lean();
  (run.configuration as Config).plafondUSD = demande?.plafondUSD ?? reglages.plafondUSD;
  etape.statut = 'en_attente';
  run.statut = 'en_cours';
  run.markModified('etapes');
  run.markModified('configuration');
  await run.save();
  await planifier(runId, etape.nom);
}

/** Relance UNIQUE après « à retravailler » : reprise depuis l'étape 4 avec les cas de réserve. */
export async function relancerExecution(runId: string): Promise<void> {
  const run = await SkillRun.findById(runId);
  if (!run) throw new AppError('Exécution introuvable', 404);
  if (run.verdict !== 'a_retravailler' || run.relances >= 1) throw new AppError('Relance possible une seule fois, après un verdict « à retravailler ».', 400);
  if (run.purge) throw new AppError('Exécution purgée : relance impossible.', 400);
  run.relances = 1;
  run.statut = 'en_cours';
  run.verdict = undefined;
  for (const e of run.etapes) {
    if (e.nom === 'skill_fusion' || e.nom === 'skill_livrables') {
      e.statut = 'en_attente';
    }
    if (e.nom === 'skill_controle') e.statut = 'en_attente'; // sa sortie précédente (échecs) sert de preuve à la fusion
  }
  run.markModified('etapes');
  await run.save();
  await planifier(runId, 'skill_fusion');
}

/** « Purger les brouillons » : sorties intermédiaires supprimées, skill final et preuve gardés. */
export async function purgerBrouillons(runId: string): Promise<void> {
  const run = await SkillRun.findById(runId);
  if (!run) throw new AppError('Exécution introuvable', 404);
  if (run.statut !== 'termine') throw new AppError('Seule une exécution terminée peut être purgée.', 400);
  for (const e of run.etapes) e.sortie = undefined;
  run.purge = true;
  run.markModified('etapes');
  await run.save();
  await SkillTestCase.deleteMany({ runId: run._id });
}

/** Calibrage humain : 3 sorties tirées au hasard avec la note de l'évaluateur (aucun effet sur le pipeline). */
export async function calibrage(runId: string) {
  const run = await SkillRun.findById(runId).lean();
  if (!run) throw new AppError('Exécution introuvable', 404);
  const sorties = [
    ...((run.etapes.find((e) => e.nom === 'skill_tests')?.sortie as { sorties?: SortieNotee[] } | undefined)?.sorties ?? []),
    ...((run.etapes.find((e) => e.nom === 'skill_controle')?.sortie as { sorties?: SortieNotee[] } | undefined)?.sorties ?? []),
  ];
  const cas = await SkillTestCase.find({ runId: run._id, type: { $in: ['entrainement', 'controle', 'reserve'] } }).lean();
  return melanger(sorties)
    .slice(0, 3)
    .map((s) => {
      const c = cas.find((x) => x.casId === s.casId)?.contenu as Cas | undefined;
      return {
        cas: s.casId,
        type: s.casType,
        message: c?.message_utilisateur ?? '',
        comportementAttendu: c?.comportement_attendu ?? '',
        sortie: s.texte,
        score: s.score,
        invention: s.invention,
        notes: (s.notes ?? []).map((n) => ({ ...n, critere: c?.criteres.find((k) => k.id === n.id)?.description ?? n.id })),
      };
    });
}
