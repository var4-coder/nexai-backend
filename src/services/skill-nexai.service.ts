import { z } from 'zod';
import { Types } from 'mongoose';
import { AppError } from '@/middleware/errorHandler';
import { Skill, SkillRequest, SkillRun, ETAPES_AFFICHEES } from '@/models/AtelierSkills';
import { User } from '@/models/User';
import { lancerExecution } from '@/services/atelier-skills/pipeline';
import { DELAI_RELANCE_CLIENT_MS, PLAFOND_COMMANDE_CLIENT_USD, rembourserCommandeSkill } from '@/services/atelier-skills/commandes-client';
import { assertSkillPlanAllowed, creditCredits, debitCredits, CREDIT_COSTS } from '@/services/credits.service';

/**
 * Skill NexAI — le client décrit son skill dans le chat (mode « skill »), le
 * brief validé part à l'équipe IA de l'Atelier Skills, le skill terminé est
 * livré dans « Mes skills ». Un skill de client est PRIVÉ : il n'est jamais
 * déposé en boutique (seul l'admin dépose les skills généraux).
 */

export const briefSkillSchema = z.object({
  domaine: z.string().trim().min(2).max(120),
  tache: z.string().trim().min(10).max(2000),
  public: z.string().trim().max(500).default(''),
  langue: z.string().trim().min(2).max(40).default('fr'),
  contexte: z
    .object({
      pays: z.string().trim().max(80).optional(),
      devise: z.string().trim().max(20).optional(),
      canal: z.string().trim().max(120).optional(),
      autre: z.string().trim().max(500).optional(),
    })
    .default({}),
});
export type BriefSkill = z.infer<typeof briefSkillSchema>;

/**
 * Débite, crée la demande, lance l'Atelier. Si quoi que ce soit échoue après
 * le débit, le client est recrédité immédiatement.
 */
export async function commanderSkill(userId: string, chatSessionId: string, brief: BriefSkill) {
  const user = await User.findById(userId).select('plan role');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  assertSkillPlanAllowed(user.plan, user.role);

  const prix = CREDIT_COSTS.SKILL_NEXAI;
  await debitCredits(userId, prix, 'skill_nexai', { action: 'SKILL_NEXAI', note: `Skill NexAI — ${brief.domaine}` });

  // Un admin n'est pas débité (montant 0) : rien à rembourser pour lui.
  const debites = user.role === 'admin' ? 0 : prix;
  let demandeId: string | undefined;
  try {
    const demande = await SkillRequest.create({
      ...brief,
      type: 'skill',
      produitPhare: false,
      voisins: [],
      creePar: `client:${userId}`,
      userId: new Types.ObjectId(userId),
      chatSessionId: new Types.ObjectId(chatSessionId),
      creditsDebites: debites,
      plafondUSD: PLAFOND_COMMANDE_CLIENT_USD,
    });
    demandeId = String(demande._id);
    const run = await lancerExecution(demandeId);
    return { requestId: demandeId, runId: String(run._id), creditsDebites: debites };
  } catch (err) {
    // Seul remboursement automatique d'un skill : NexAI n'a pas pu lancer la
    // commande. Un échec de remboursement est journalisé, jamais avalé.
    const alerte = (e: unknown) => console.error(`[skill-nexai] ALERTE : remboursement impossible user=${userId} montant=${debites}`, e);
    if (demandeId && debites > 0) await rembourserCommandeSkill(demandeId, 'lancement impossible').catch(alerte);
    else if (debites > 0) await creditCredits(userId, debites, 'skill_nexai_remboursement', { note: 'Skill NexAI — lancement impossible' }).catch(alerte);
    throw err;
  }
}

/**
 * en_cours        : l'équipe IA travaille.
 * livre           : le skill est prêt, téléchargeable.
 * relance_possible: première tentative non aboutie ; relance gratuite (dès `relanceDisponibleLe`).
 * assistance      : les deux essais ont échoué ; le client est orienté vers l'assistance NexAI.
 */
type EtatCommande = 'en_cours' | 'livre' | 'relance_possible' | 'assistance';

export interface CommandeSkillVue {
  id: string;
  domaine: string;
  tache: string;
  creeLe: Date;
  etat: EtatCommande;
  etapeActuelle: number;
  etapes: { numero: number; titre: string; statut: 'attente' | 'en_cours' | 'termine' }[];
  skillId?: string;
  nom?: string;
  creditsDebites: number;
  /** relance_possible : date à partir de laquelle le bouton « Relancer » est actif. */
  relanceDisponibleLe?: Date;
  peutRelancerMaintenant: boolean;
}

type RunLean = {
  requestId: Types.ObjectId;
  statut: string;
  verdict?: string;
  etapes: { nom: string; statut: string }[];
  skillId?: Types.ObjectId;
  updatedAt: Date;
};

const echecTerminal = (r: RunLean) => r.statut === 'echec' || r.statut === 'plafond_atteint' || (r.statut === 'termine' && r.verdict !== 'publie');

/** Liste des skills commandés par le client, avec leur avancement en 5 étapes. Aucune donnée interne (coûts, modèles, notes) n'est exposée. */
export async function listerMesCommandes(userId: string): Promise<CommandeSkillVue[]> {
  const demandes = await SkillRequest.find({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).limit(50).lean();
  if (demandes.length === 0) return [];
  const runs = (await SkillRun.find({ requestId: { $in: demandes.map((d) => d._id) } })
    .sort({ createdAt: 1 })
    .select('requestId statut verdict etapes skillId updatedAt')
    .lean()) as unknown as RunLean[];
  const runsParDemande = new Map<string, RunLean[]>();
  for (const r of runs) runsParDemande.set(String(r.requestId), [...(runsParDemande.get(String(r.requestId)) ?? []), r]);
  const skills = await Skill.find({ _id: { $in: runs.map((r) => r.skillId).filter(Boolean) } })
    .select('nom')
    .lean();
  const nomSkill = new Map(skills.map((s) => [String(s._id), s.nom]));

  return demandes.map((d) => {
    const liste = runsParDemande.get(String(d._id)) ?? [];
    const dernier = liste[liste.length - 1];
    const livree = liste.find((r) => r.statut === 'termine' && r.verdict === 'publie' && !!r.skillId);
    const statutTache = (nom: string) => dernier?.etapes.find((e) => e.nom === nom)?.statut;
    const etapes = ETAPES_AFFICHEES.map((e) => {
      const st = e.taches.map((t) => statutTache(t));
      const fini = st.every((x) => x === 'termine' || x === 'saute');
      const enCours = st.some((x) => x === 'en_cours' || x === 'termine' || x === 'echec') && !fini;
      return { numero: e.numero, titre: e.titre, statut: (fini ? 'termine' : enCours ? 'en_cours' : 'attente') as 'attente' | 'en_cours' | 'termine' };
    });

    let etat: EtatCommande = 'en_cours';
    let relanceDisponibleLe: Date | undefined;
    if (livree) etat = 'livre';
    else if (dernier && echecTerminal(dernier)) {
      if (d.relanceClient || liste.length >= 2) etat = 'assistance';
      else {
        etat = 'relance_possible';
        relanceDisponibleLe = new Date(new Date(dernier.updatedAt).getTime() + DELAI_RELANCE_CLIENT_MS);
      }
    }
    const premiereNonFinie = etapes.find((e) => e.statut !== 'termine');
    return {
      id: String(d._id),
      domaine: d.domaine,
      tache: d.tache,
      creeLe: d.createdAt,
      etat,
      etapeActuelle: livree ? 5 : premiereNonFinie?.numero ?? 5,
      etapes,
      skillId: livree ? String(livree.skillId) : undefined,
      nom: livree?.skillId ? nomSkill.get(String(livree.skillId)) : undefined,
      creditsDebites: d.creditsDebites ?? 0,
      relanceDisponibleLe,
      peutRelancerMaintenant: etat === 'relance_possible' && !!relanceDisponibleLe && relanceDisponibleLe.getTime() <= Date.now(),
    };
  });
}

/**
 * Second essai GRATUIT, une seule fois par commande, 30 minutes après l'échec
 * du premier. Lance une nouvelle exécution complète sur la même demande.
 */
export async function relancerCommande(userId: string, requestId: string) {
  if (!Types.ObjectId.isValid(requestId)) throw new AppError('Commande introuvable', 404);
  const user = await User.findById(userId).select('plan role');
  if (!user) throw new AppError('Utilisateur introuvable', 404);
  assertSkillPlanAllowed(user.plan, user.role);

  const demande = await SkillRequest.findOne({ _id: requestId, userId: new Types.ObjectId(userId) }).lean();
  if (!demande) throw new AppError('Commande introuvable', 404);
  const runs = (await SkillRun.find({ requestId: demande._id }).sort({ createdAt: 1 }).select('requestId statut verdict etapes skillId updatedAt').lean()) as unknown as RunLean[];
  const dernier = runs[runs.length - 1];
  if (runs.some((r) => r.statut === 'termine' && r.verdict === 'publie')) throw new AppError('Votre skill est déjà prêt.', 400);
  if (!dernier || !echecTerminal(dernier)) throw new AppError('Votre skill est encore en cours de création.', 400);
  if (demande.relanceClient || runs.length >= 2) {
    throw new AppError('Le second essai gratuit a déjà été utilisé. Contactez l’assistance NexAI : nous allons examiner votre commande.', 400);
  }
  const attente = new Date(dernier.updatedAt).getTime() + DELAI_RELANCE_CLIENT_MS - Date.now();
  if (attente > 0) {
    throw new AppError(`Relance possible dans ${Math.ceil(attente / 60000)} min.`, 429);
  }

  // Verrou atomique : un double clic ne lance jamais deux exécutions.
  const verrou = await SkillRequest.findOneAndUpdate({ _id: demande._id, relanceClient: { $ne: true } }, { $set: { relanceClient: true } });
  if (!verrou) throw new AppError('Une relance est déjà en cours.', 409);
  try {
    const run = await lancerExecution(String(demande._id));
    return { runId: String(run._id) };
  } catch (err) {
    await SkillRequest.updateOne({ _id: demande._id }, { $set: { relanceClient: false } });
    throw err;
  }
}

/** Fichiers d'un skill livré — uniquement pour le client qui l'a commandé. */
export async function fichierMonSkill(userId: string, skillId: string, type: 'zip' | 'guide' | 'preuve' | 'acoller') {
  if (!Types.ObjectId.isValid(skillId)) throw new AppError('Skill introuvable', 404);
  const skill = await Skill.findById(skillId).select('+fichiers.zip +fichiers.guidePdf +fichiers.preuvePdf slug runId verdict');
  if (!skill) throw new AppError('Skill introuvable', 404);
  const run = await SkillRun.findById(skill.runId).select('requestId').lean();
  const demande = run ? await SkillRequest.findOne({ _id: run.requestId, userId: new Types.ObjectId(userId) }).select('_id rembourse').lean() : null;
  if (!demande || demande.rembourse || skill.verdict !== 'publie') throw new AppError('Skill introuvable', 404);

  const f = skill.fichiers;
  switch (type) {
    case 'zip':
      if (!f?.zip) break;
      return { buffer: Buffer.from(f.zip as Buffer), nom: `${skill.slug}.zip`, mime: 'application/zip' };
    case 'guide':
      if (!f?.guidePdf) break;
      return { buffer: Buffer.from(f.guidePdf as Buffer), nom: `${skill.slug}-guide.pdf`, mime: 'application/pdf' };
    case 'preuve':
      if (!f?.preuvePdf) break;
      return { buffer: Buffer.from(f.preuvePdf as Buffer), nom: `${skill.slug}-preuve.pdf`, mime: 'application/pdf' };
    case 'acoller':
      if (!f?.aColler) break;
      return { buffer: Buffer.from(f.aColler, 'utf8'), nom: `${skill.slug}-a-coller.txt`, mime: 'text/plain; charset=utf-8' };
  }
  throw new AppError('Ce fichier n’est pas disponible pour ce skill.', 404);
}
