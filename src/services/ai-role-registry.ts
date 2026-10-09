import { AiRoleConfig, AiRole } from '@/models/AiRoleConfig';
import { AppError } from '@/middleware/errorHandler';

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
    alternatives: ['claude-sonnet-5-5', 'grok-4.6'],
  },
  chat_autres_modes: {
    label: 'Chat — sous-modes Logo / Modifier un site / Coach business',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['claude-sonnet-5-5', 'grok-4.6'],
  },
  chat_skill: {
    label: 'Chat — Skill NexAI (dialogue + extraction du brief)',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['claude-sonnet-5-5', 'grok-4.6'],
  },
  // Traduction des contenus de la base (Académie, Boutique…) dans la langue
  // d'interface du client. Mise en cache : chaque texte n'est traduit qu'une fois.
  traduction_interface: {
    label: 'Traduction des contenus (Académie, Boutique, Skills) dans la langue du client',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['grok-4.3'],
  },
  support_client: {
    label: 'Support client',
    default: 'claude-haiku-4-5-20251001',
    alternatives: ['grok-4.3', 'grok-4.6'],
  },
  // Codeur de l'essai gratuit ET du Standard (décision du 03/10/2026) :
  // Grok 4.7 par défaut, Sonnet 5.5 en alternance depuis l'admin. Le modèle
  // est lu UNE fois au début de la génération : il code l'accueil ET toutes
  // les pages intérieures du site (un seul codeur par site). Le juge visuel
  // s'adapte automatiquement (voir getJugeVisuelPour).
  codeur_normale: {
    label: 'Codeur — essai gratuit et Standard (toutes les pages du site)',
    default: 'grok-4.7',
    alternatives: ['claude-sonnet-5-5'],
  },
  // Premium : Opus 5.5 code l'accueil et toutes les pages intérieures.
  codeur_premium: {
    label: 'Codeur — qualité Premium (toutes les pages du site)',
    default: 'claude-opus-5-5',
    alternatives: ['claude-sonnet-5-5'],
  },
  // Validation visuelle de l'image pro avec logo (décision du 03/10/2026) :
  // une image refusée est remplacée par la photo de la galerie.
  verif_image_logo: {
    label: 'Validation de l’image pro avec logo (vision)',
    default: 'claude-sonnet-5-5',
    alternatives: ['claude-opus-5-5'],
  },
  juge_code: {
    label: 'Juge Code (Scan 1 + Scan 2)',
    default: 'grok-4.5',
    alternatives: [],
  },
  // Réparateur NexAI : Grok Build par défaut, Sonnet 5.5 en alternance.
  // Lu une seule fois au début de la génération : un site garde le même
  // réparateur du début à la fin (accueil et pages intérieures).
  reparateur_code: {
    label: 'Réparateur de code (corrections ciblées)',
    default: 'grok-build-0.1',
    alternatives: ['claude-sonnet-5-5'],
  },
  // Architecture v6 : Sonnet 5 juge dans LES DEUX qualités. Opus 5.5
  // n'intervient jamais comme juge, uniquement comme « Aide » en
  // reconstruction (voir aide_ia_payant).
  // Juge visuel OFFICIEL. Remplacé automatiquement par Sonnet 5 lorsque
  // c'est Opus 5.5 qui a codé (voir getJugeVisuelPour) — ce réglage ne peut
  // donc jamais conduire un modèle à juger sa propre production.
  juge_visuel: {
    label: 'Juge Visuel (officiel)',
    default: 'claude-opus-5-5',
    alternatives: ['claude-sonnet-5-5'],
  },
  aide_ia_essai: {
    label: 'Aide IA — essai gratuit',
    default: 'claude-sonnet-5-5',
    alternatives: [],
  },
  aide_ia_payant: {
    label: 'Aide IA — plans payants',
    default: 'claude-opus-5-5',
    alternatives: [],
  },
  amelioration_prompts: {
    label: 'Amélioration des prompts',
    default: 'claude-sonnet-5-5',
    alternatives: [],
  },
  diagnostic_ameliorer_site: {
    label: 'Diagnostic « Améliorer un site »',
    default: 'claude-opus-5-5',
    alternatives: [],
  },
  agent_qualite_alertes: {
    label: 'Agent qualité — alertes payantes',
    default: 'claude-opus-5-5',
    alternatives: [],
  },
  titre_accroche_academy_boutique: {
    label: 'Titre-accroche Academy & Boutique',
    default: 'claude-sonnet-5-5',
    alternatives: [],
  },
};

/**
 * Modèle de SECOURS des conversations (décision du 09/10/2026) : si le
 * modèle principal échoue (crédit épuisé, panne, saturation…), la même
 * demande repart aussitôt sur ce modèle, d'un autre fournisseur. Le client
 * ne voit aucune coupure ; l'administrateur reçoit un incident.
 * Choisi depuis l'admin « Équipe IA » ; « aucun » désactive la bascule.
 */
export const SECOURS_AUCUN = 'aucun';
export const SECOURS_REGISTRY: Partial<Record<AiRole, { default: string; alternatives: string[] }>> = {
  chat_creation_site: { default: 'grok-4.6', alternatives: ['grok-4.7', 'grok-4.3', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', SECOURS_AUCUN] },
  chat_autres_modes: { default: 'grok-4.6', alternatives: ['grok-4.7', 'grok-4.3', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', SECOURS_AUCUN] },
  chat_skill: { default: 'grok-4.6', alternatives: ['grok-4.7', 'grok-4.3', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', SECOURS_AUCUN] },
  support_client: { default: 'grok-4.6', alternatives: ['grok-4.7', 'grok-4.3', 'claude-haiku-4-5-20251001', SECOURS_AUCUN] },
  traduction_interface: { default: 'grok-4.3', alternatives: ['grok-4.6', 'claude-haiku-4-5-20251001', SECOURS_AUCUN] },
};

/** Anciens identifiants de modèle → leur remplaçant. */
const MODELES_REMPLACES: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5-5',
};

/**
 * Migration des réglages admin déjà enregistrés en base, UNIQUEMENT pour les rôles de création de site :
 * Sonnet 5 → Sonnet 5.5, Fable 5.1 → Opus 5.5 (Fable n'est plus utilisé dans le système interne).
 * Les autres rôles (support, chat hors site, academy…) ne sont pas touchés.
 */
const ROLES_SITE_MIGRES = new Set<string>([
  'chat_creation_site', 'codeur_normale', 'codeur_premium', 'juge_visuel', 'aide_ia_essai', 'diagnostic_ameliorer_site', 'agent_qualite_alertes',
]);
const MIGRATION_SITE: Record<string, string> = {
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
  'claude-fable-5-1': 'claude-opus-5-5',
};

const cache = new Map<AiRole, string>();
const cacheSecours = new Map<AiRole, string>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // évite de relire Mongo à chaque appel IA

async function ensureCache() {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && cache.size > 0) return;
  const rows = await AiRoleConfig.find().lean();
  cache.clear();
  cacheSecours.clear();
  for (const row of rows) {
    if (row.secoursModel) cacheSecours.set(row.role as AiRole, row.secoursModel);
    // Opus 5 remplacé par Opus 5.5 : un réglage admin enregistré avant la
    // mise à jour bascule automatiquement sur le nouveau modèle.
    let modele = MODELES_REMPLACES[row.activeModel] ?? row.activeModel;
    if (ROLES_SITE_MIGRES.has(String(row.role))) modele = MIGRATION_SITE[modele] ?? modele;
    // Sonnet 5 → Sonnet 5.5 pour TOUS les rôles (décision du 03/10/2026).
    if (modele === 'claude-sonnet-5') modele = 'claude-sonnet-5-5';
    cache.set(row.role as AiRole, modele);
  }
  cacheLoadedAt = Date.now();
}

/**
 * Renvoie le modèle actif pour un rôle donné : la valeur configurée en base
 * si elle existe, sinon le modèle par défaut du registre. Utilisé par
 * chaque service IA à la place d'un nom de modèle écrit en dur.
 */
export async function getModelForRole(role: AiRole): Promise<string> {
  await ensureCache();
  return modeleValide(role, cache.get(role));
}

/**
 * Modèle de secours d'un rôle de conversation, ou null si la bascule est
 * désactivée (ou si le rôle n'en a pas). Jamais le même modèle que le
 * principal : dans ce cas on prend l'autre fournisseur.
 */
export async function getSecoursForRole(role: AiRole, principal?: string): Promise<string | null> {
  const entree = SECOURS_REGISTRY[role];
  if (!entree) return null;
  await ensureCache();
  const enregistre = cacheSecours.get(role);
  const choisi =
    enregistre && (enregistre === entree.default || entree.alternatives.includes(enregistre)) ? enregistre : entree.default;
  if (choisi === SECOURS_AUCUN) return null;
  const actif = principal ?? (await getModelForRole(role));
  if (choisi === actif) return actif.startsWith('grok-') ? 'claude-haiku-4-5-20251001' : 'grok-4.6';
  return choisi;
}

/** Choix du modèle de secours depuis l'admin (liste fermée, comme le modèle principal). */
export async function setSecoursForRole(role: AiRole, model: string, adminEmail?: string) {
  const entree = SECOURS_REGISTRY[role];
  if (!entree) throw new AppError(`Le rôle "${role}" n'a pas de modèle de secours réglable.`, 400);
  const autorises = new Set([entree.default, ...entree.alternatives]);
  if (!autorises.has(model)) {
    throw new AppError(`Modèle de secours "${model}" non autorisé. Choix possibles : ${[...autorises].join(', ')}`, 400);
  }
  await AiRoleConfig.findOneAndUpdate(
    { role },
    { $set: { secoursModel: model, updatedBy: adminEmail }, $setOnInsert: { activeModel: AI_ROLE_REGISTRY[role].default } },
    { upsert: true, new: true }
  );
  cacheLoadedAt = 0;
}

/**
 * Un réglage enregistré qui n'est plus autorisé pour ce poste (ex. Grok 4.6
 * retiré du codeur le 03/10/2026) n'est jamais utilisé : on revient au
 * modèle par défaut du registre au lieu d'appeler un modèle non prévu.
 */
function modeleValide(role: AiRole, enregistre: string | undefined): string {
  const entree = AI_ROLE_REGISTRY[role];
  if (!entree) return enregistre || '';
  if (!enregistre) return entree.default;
  if (enregistre === entree.default || entree.alternatives.includes(enregistre)) return enregistre;
  return entree.default;
}

/**
 * Bascule un rôle vers un modèle — rejette toute valeur absente de la
 * liste des alternatives compatibles (protection contre une config
 * invalide qui casserait silencieusement un poste, ex. un modèle sans
 * vision assigné au Juge Visuel).
 */
export async function setModelForRole(role: AiRole, model: string, adminEmail?: string) {
  const entry = AI_ROLE_REGISTRY[role];
  if (!entry) throw new AppError(`Rôle IA inconnu : ${role}`, 404);
  const allowed = new Set([entry.default, ...entry.alternatives]);
  if (!allowed.has(model)) {
    // 400 : réglage refusé, pas une panne (aucune alerte incident).
    throw new AppError(
      `Modèle "${model}" non compatible avec le rôle "${role}". Modèles autorisés : ${[...allowed].join(', ')}`,
      400
    );
  }
  await AiRoleConfig.findOneAndUpdate(
    { role },
    { $set: { role, activeModel: model, updatedBy: adminEmail } },
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
    activeModel: modeleValide(role, cache.get(role)),
    defaultModel: AI_ROLE_REGISTRY[role].default,
    alternatives: AI_ROLE_REGISTRY[role].alternatives,
    secours: SECOURS_REGISTRY[role]
      ? {
          actif: (() => {
            const e = SECOURS_REGISTRY[role]!;
            const v = cacheSecours.get(role);
            return v && (v === e.default || e.alternatives.includes(v)) ? v : e.default;
          })(),
          defaut: SECOURS_REGISTRY[role]!.default,
          choix: [SECOURS_REGISTRY[role]!.default, ...SECOURS_REGISTRY[role]!.alternatives],
        }
      : null,
  }));
}

/**
 * Juge visuel à utiliser pour une production donnée.
 *
 * RÈGLE : un modèle ne juge jamais sa propre production.
 *
 * Le juge officiel s'applique à tout ce qu'il n'a pas lui-même codé.
 * Quand le codeur est le même modèle que le juge (Opus, Fable, Sonnet),
 * l'autre famille prend le relais. Cette règle ne peut pas être contournée.
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
  // Le juge officiel a lui-même codé : on bascule pour ne jamais s'auto-juger.
  if (modeleCodeur.startsWith('claude-fable') || modeleCodeur === 'claude-opus-5-5') {
    return 'claude-sonnet-5-5';
  }
  return officiel === 'claude-sonnet-5-5' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
}
