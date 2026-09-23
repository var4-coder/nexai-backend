import { AiRoleConfig, AiRole } from '@/models/AiRoleConfig';

/**
 * Registre central du panneau admin "Équipe IA". Pour chaque rôle : le
 * modèle par défaut, et la liste des alternatives réellement COMPATIBLES
 * avec ce poste (jamais une bascule libre — un modèle sans vision ne sera
 * par exemple jamais proposé pour le Juge Visuel).
 *
 * Seul 'support_client', 'chat_creation_site' et 'chat_autres_modes' ont une
 * vraie alternative validée à ce jour (Haiku 4.5 ↔ Sonnet 5, ou ↔ Grok 4.3
 * pour le support). Les autres rôles n'ont qu'un seul modèle
 * "compatible" pour l'instant, mais passent par le même mécanisme de
 * résolution — ajouter une alternative future ne nécessite qu'une ligne de
 * config ici, jamais une réécriture de code appelant.
 */
export const AI_ROLE_REGISTRY: Record<AiRole, { label: string; default: string; alternatives: string[] }> = {
  chat_creation_site: {
    // Split (demandé) : ce rôle ne couvre plus QUE le sous-mode "site" du
    // chat hub (conversation + extraction du brief business). Les 3 autres
    // sous-modes (logo / edit / business) sont un rôle séparé ci-dessous —
    // les deux peuvent être basculés indépendamment entre Haiku et Sonnet 5
    // depuis ce panneau, sans toucher au code.
    label: 'Chat création de site — sous-mode "site" (dialogue + extraction brief)',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['claude-sonnet-5'],
  },
  chat_autres_modes: {
    label: 'Chat — sous-modes Logo / Modifier un site / Coach business',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['claude-sonnet-5'],
  },
  support_client: {
    label: 'Support client',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['grok-4.3'],
  },
  // Codeur de l'essai gratuit ET du premier aperçu Normale. Alternable
  // entre Grok et Sonnet depuis l'admin, pour comparer les taux de
  // conversion réels. Le juge visuel s'adapte automatiquement (voir
  // getJugeVisuelPour) : un modèle ne juge jamais sa propre production.
  codeur_normale: {
    label: 'Codeur — essai gratuit et aperçu 1 Normale',
    default: 'grok-4.7',
    alternatives: ['grok-4.6', 'claude-sonnet-5'],
  },
  // Second aperçu Normale : un moteur différent du premier, pour offrir au
  // client deux propositions de styles réellement distincts.
  codeur_normale_apercu2: {
    label: 'Codeur — aperçu 2 Normale',
    default: 'claude-sonnet-5',
    alternatives: ['grok-4.7', 'grok-4.6'],
  },
  codeur_premium: {
    label: 'Codeur — qualité Premium',
    default: 'claude-opus-5',
    alternatives: ['claude-sonnet-5'],
  },
  juge_code: {
    label: 'Juge Code (Scan 1 + Scan 2)',
    default: 'grok-4.5',
    alternatives: [],
  },
  reparateur_code: {
    label: 'Réparateur de code',
    default: 'grok-build-0.1',
    alternatives: [],
  },
  // Architecture v6 : Sonnet 5 juge dans LES DEUX qualités. Opus 5
  // n'intervient jamais comme juge, uniquement comme « Aide » en
  // reconstruction (voir aide_ia_payant).
  // Juge visuel OFFICIEL. Remplacé automatiquement par Sonnet 5 lorsque
  // c'est Opus 5 qui a codé (voir getJugeVisuelPour) — ce réglage ne peut
  // donc jamais conduire un modèle à juger sa propre production.
  juge_visuel: {
    label: 'Juge Visuel (officiel)',
    default: 'claude-opus-5',
    alternatives: ['claude-sonnet-5'],
  },
  aide_ia_essai: {
    label: 'Aide IA — essai gratuit',
    default: 'claude-sonnet-5',
    alternatives: [],
  },
  aide_ia_payant: {
    label: 'Aide IA — plans payants',
    default: 'claude-opus-5',
    alternatives: [],
  },
  amelioration_prompts: {
    label: 'Amélioration des prompts',
    default: 'claude-sonnet-5',
    alternatives: [],
  },
  diagnostic_ameliorer_site: {
    label: 'Diagnostic « Améliorer un site »',
    default: 'claude-fable-5-1',
    alternatives: [],
  },
  agent_qualite_alertes: {
    label: 'Agent qualité — alertes payantes',
    default: 'claude-fable-5-1',
    alternatives: [],
  },
  titre_accroche_academy_boutique: {
    label: 'Titre-accroche Academy & Boutique',
    default: 'claude-sonnet-5',
    alternatives: [],
  },
};

const cache = new Map<AiRole, string>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // évite de relire Mongo à chaque appel IA

async function ensureCache() {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && cache.size > 0) return;
  const rows = await AiRoleConfig.find().lean();
  cache.clear();
  for (const row of rows) cache.set(row.role as AiRole, row.activeModel);
  cacheLoadedAt = Date.now();
}

/**
 * Renvoie le modèle actif pour un rôle donné : la valeur configurée en base
 * si elle existe, sinon le modèle par défaut du registre. Utilisé par
 * chaque service IA à la place d'un nom de modèle écrit en dur.
 */
export async function getModelForRole(role: AiRole): Promise<string> {
  await ensureCache();
  return cache.get(role) || AI_ROLE_REGISTRY[role].default;
}

/**
 * Bascule un rôle vers un modèle — rejette toute valeur absente de la
 * liste des alternatives compatibles (protection contre une config
 * invalide qui casserait silencieusement un poste, ex. un modèle sans
 * vision assigné au Juge Visuel).
 */
export async function setModelForRole(role: AiRole, model: string, adminEmail?: string) {
  const entry = AI_ROLE_REGISTRY[role];
  if (!entry) throw new Error(`Rôle IA inconnu : ${role}`);
  const allowed = new Set([entry.default, ...entry.alternatives]);
  if (!allowed.has(model)) {
    throw new Error(
      `Modèle "${model}" non compatible avec le rôle "${role}". Modèles autorisés : ${[...allowed].join(', ')}`
    );
  }
  await AiRoleConfig.findOneAndUpdate(
    { role },
    { role, activeModel: model, updatedBy: adminEmail },
    { upsert: true, new: true }
  );
  cacheLoadedAt = 0; // force un rechargement au prochain appel
}

/** Liste complète pour l'écran admin "Équipe IA" : rôle, modèle actif, alternatives. */
export async function listAiTeamConfig() {
  await ensureCache();
  return (Object.keys(AI_ROLE_REGISTRY) as AiRole[]).map((role) => ({
    role,
    label: AI_ROLE_REGISTRY[role].label,
    activeModel: cache.get(role) || AI_ROLE_REGISTRY[role].default,
    defaultModel: AI_ROLE_REGISTRY[role].default,
    alternatives: AI_ROLE_REGISTRY[role].alternatives,
  }));
}

/**
 * Juge visuel à utiliser pour une production donnée.
 *
 * RÈGLE : un modèle ne juge jamais sa propre production.
 *
 * Le juge officiel (Opus 5 par défaut) s'applique à tout ce qu'il n'a pas
 * lui-même codé. Quand c'est lui qui a codé — le Premium — Sonnet 5 prend le
 * relais. Si l'admin a configuré un autre juge officiel, la même règle joue
 * dans l'autre sens.
 *
 * Cette règle est appliquée par le système à chaque génération : elle ne
 * dépend d'aucun réglage et ne peut pas être contournée par erreur en
 * changeant un codeur dans l'admin. C'est aussi ce qui rend valide la
 * comparaison Grok / Sonnet au poste de codeur : les deux sont jugés par le
 * même juge, donc un écart de conversion ne peut venir que du codeur.
 */
export async function getJugeVisuelPour(modeleCodeur: string): Promise<string> {
  const officiel = await getModelForRole('juge_visuel');
  if (officiel !== modeleCodeur) return officiel;
  return officiel === 'claude-sonnet-5' ? 'claude-opus-5' : 'claude-sonnet-5';
}
