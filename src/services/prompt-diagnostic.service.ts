import { PromptVersion, PromptCible, IPromptVersion } from '@/models/PromptVersion';
import { callClaude } from '@/services/ai-clients';
import { getModelForRole } from '@/services/ai-role-registry';
import { buildRapportQualite, SEUIL_NEGATIF_DECLENCHEMENT } from '@/services/quality-report.service';
import { AppError } from '@/middleware/errorHandler';

/**
 * Diagnostic et amélioration des prompts système — Architecture v6, section 18.
 *
 * Déroulé complet :
 *   1. Le seuil négatif NexAI atteint 40% → déclenchement automatique.
 *   2. FABLE détecte le point faible : une niche précise, un rôle précis,
 *      ou un problème systémique. Il ne réécrit rien lui-même.
 *   3. SONNET 5 rédige la correction, UNIQUEMENT pour les parties
 *      identifiées par Fable — jamais une réécriture globale du prompt.
 *   4. L'admin voit : la raison, l'effet attendu, et le diff actif/candidat.
 *      Il valide ou refuse. Son silence pendant 1h vaut acceptation.
 *   5. Toute version appliquée est archivée et restaurable en un clic.
 *
 * L'autorisation demandée à l'admin est GÉNÉRALE (autoriser l'analyse
 * système), jamais une validation site par site.
 */

/** Délai de silence après lequel un candidat est appliqué automatiquement. */
const DELAI_AUTO_APPLY_MS = 60 * 60 * 1000; // 1 heure

const PROMPT_DIAGNOSTIC_FABLE = `Tu es l'agent qualité de NexAI, une plateforme qui génère des sites web par IA.

On te transmet un rapport qualité réel : taux d'avis négatifs, taux de sites en échec, taux de vidéos rejetées, et la répartition des échecs par niche.

Ta mission : IDENTIFIER où se situe la faille. Tu ne réécris aucun prompt — tu poses le diagnostic.

Réponds UNIQUEMENT en JSON strict :
{
  "portee": "niche" | "role" | "systemique",
  "cible": "codeur_normale" | "codeur_premium" | "juge_code" | "juge_visuel" | "chat_creation" | "support_client" | "video_script",
  "niche": "<slug de la niche concernée, ou null si la portée n'est pas 'niche'>",
  "raison": "<explication courte et factuelle, appuyée sur les chiffres du rapport>",
  "pistes": ["<piste de correction 1>", "<piste de correction 2>"]
}

Règles :
- Ne conclus à "systemique" que si plusieurs niches ET plusieurs indicateurs sont dégradés simultanément.
- Appuie-toi sur les chiffres fournis, jamais sur des suppositions.
- Si les données sont trop peu nombreuses pour conclure, dis-le dans "raison" et choisis la portée la plus prudente.`;

const PROMPT_REDACTION_SONNET = `Tu es chargé de corriger un prompt système de la plateforme NexAI.

On te donne : le prompt ACTUEL, le diagnostic de l'agent qualité, et les pistes de correction.

Ta mission : produire une version corrigée qui traite UNIQUEMENT les points identifiés par le diagnostic.

Règles absolues :
- NE RÉÉCRIS PAS le prompt en entier. Conserve mot pour mot tout ce qui n'est pas concerné par le diagnostic.
- N'invente aucune règle métier (tarif, quota, nom de modèle) qui ne figure pas déjà dans le prompt actuel.
- Reste dans le même style et le même format que l'original.

Réponds UNIQUEMENT en JSON strict :
{
  "contenu": "<le prompt corrigé, complet>",
  "effet_attendu": "<en une phrase : ce que cette correction devrait améliorer>",
  "modifications": ["<changement 1>", "<changement 2>"]
}`;

interface DiagnosticFable {
  portee: 'niche' | 'role' | 'systemique';
  cible: PromptCible;
  niche: string | null;
  raison: string;
  pistes: string[];
}

function parseJson<T>(raw: string): T | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/** Renvoie le prompt actuellement actif pour une cible (et une niche). */
export async function getPromptActif(
  cible: PromptCible,
  niche: string | null = null
): Promise<IPromptVersion | null> {
  return PromptVersion.findOne({ cible, niche, statut: 'actif' });
}

/**
 * Lance le cycle complet de diagnostic. Déclenché automatiquement quand le
 * seuil de 40% est atteint, ou manuellement par l'admin.
 *
 * Ne lève jamais d'erreur bloquante : un échec de diagnostic ne doit pas
 * perturber le fonctionnement de la plateforme.
 */
export async function lancerDiagnosticPrompts(options?: { forcer?: boolean }): Promise<{
  lance: boolean;
  raison?: string;
  candidatId?: string;
}> {
  const rapport = await buildRapportQualite();

  if (!rapport.declenchementAtteint && !options?.forcer) {
    return {
      lance: false,
      raison: `Seuil négatif à ${rapport.seuilNegatifGlobal}% — sous le seuil de déclenchement (${SEUIL_NEGATIF_DECLENCHEMENT}%).`,
    };
  }

  // ── 1. Fable détecte ────────────────────────────────────────
  const modeleDiagnostic = await getModelForRole('amelioration_prompts');
  const rapportTexte = JSON.stringify(
    {
      seuil_negatif_global: rapport.seuilNegatifGlobal,
      taux: rapport.taux,
      niches_faibles: rapport.nichesFaibles,
      nb_sites_faibles: rapport.sitesFaibles.length,
    },
    null,
    2
  );

  const diagnosticRaw = await callClaude(
    'claude-fable-5-1',
    PROMPT_DIAGNOSTIC_FABLE,
    [{ role: 'user', content: `Rapport qualité (30 derniers jours) :\n${rapportTexte}` }],
    { maxTokens: 1500, temperature: 0.2 }
  );

  const diagnostic = parseJson<DiagnosticFable>(diagnosticRaw);
  if (!diagnostic?.cible) {
    return { lance: false, raison: 'Diagnostic illisible — aucune proposition générée.' };
  }

  // ── 2. Sonnet rédige la correction ──────────────────────────
  const niche = diagnostic.portee === 'niche' ? diagnostic.niche : null;
  const actif = await getPromptActif(diagnostic.cible, niche);
  if (!actif) {
    return {
      lance: false,
      raison: `Aucun prompt actif enregistré pour « ${diagnostic.cible} » — rien à corriger.`,
    };
  }

  const redactionRaw = await callClaude(
    modeleDiagnostic as 'claude-sonnet-5',
    PROMPT_REDACTION_SONNET,
    [
      {
        role: 'user',
        content: `PROMPT ACTUEL :\n${actif.contenu}\n\nDIAGNOSTIC :\n${diagnostic.raison}\n\nPISTES :\n${diagnostic.pistes.join('\n- ')}`,
      },
    ],
    { maxTokens: 8000, temperature: 0.3 }
  );

  const redaction = parseJson<{ contenu: string; effet_attendu: string; modifications: string[] }>(
    redactionRaw
  );
  if (!redaction?.contenu) {
    return { lance: false, raison: 'Correction illisible — aucune proposition générée.' };
  }

  // Ne propose rien si le texte est identique (évite un candidat vide).
  if (redaction.contenu.trim() === actif.contenu.trim()) {
    return { lance: false, raison: 'La correction proposée est identique au prompt actuel.' };
  }

  // ── 3. Enregistrement du candidat, en attente de décision ───
  const candidat = await PromptVersion.create({
    cible: diagnostic.cible,
    niche,
    statut: 'candidat',
    version: actif.version + 1,
    contenu: redaction.contenu,
    raisonDiagnostic: diagnostic.raison,
    effetAttendu: redaction.effet_attendu,
    seuilNegatifDeclencheur: rapport.seuilNegatifGlobal,
    remplaceVersionId: actif._id,
    autoApplyAt: new Date(Date.now() + DELAI_AUTO_APPLY_MS),
  });

  console.log(
    `[prompts] Candidat créé pour ${diagnostic.cible}${niche ? ` (niche ${niche})` : ''} — seuil ${rapport.seuilNegatifGlobal}%`
  );

  return { lance: true, candidatId: String(candidat._id) };
}

/** Applique un candidat : il devient actif, l'ancien passe en archive. */
export async function appliquerCandidat(
  candidatId: string,
  decidePar: string
): Promise<IPromptVersion> {
  const candidat = await PromptVersion.findById(candidatId);
  if (!candidat) throw new AppError('Proposition introuvable.', 404);
  if (candidat.statut !== 'candidat') {
    throw new AppError('Cette proposition a déjà été traitée.', 400);
  }

  // L'ancien actif passe en archive AVANT que le candidat ne devienne actif
  // (l'index unique interdit deux versions actives simultanées).
  await PromptVersion.updateMany(
    { cible: candidat.cible, niche: candidat.niche, statut: 'actif' },
    { $set: { statut: 'archive' } }
  );

  candidat.statut = 'actif';
  candidat.decidePar = decidePar;
  candidat.decideAt = new Date();
  await candidat.save();

  console.log(`[prompts] Version ${candidat.version} appliquée pour ${candidat.cible} par ${decidePar}`);
  return candidat;
}

/** Refuse un candidat — le prompt actif reste inchangé. */
export async function refuserCandidat(
  candidatId: string,
  decidePar: string
): Promise<IPromptVersion> {
  const candidat = await PromptVersion.findById(candidatId);
  if (!candidat) throw new AppError('Proposition introuvable.', 404);
  if (candidat.statut !== 'candidat') {
    throw new AppError('Cette proposition a déjà été traitée.', 400);
  }

  candidat.statut = 'rejete';
  candidat.decidePar = decidePar;
  candidat.decideAt = new Date();
  await candidat.save();
  return candidat;
}

/**
 * Restaure une version archivée — disponible à tout moment, même après
 * qu'une autre version a été validée.
 */
export async function restaurerVersion(
  versionId: string,
  decidePar: string
): Promise<IPromptVersion> {
  const version = await PromptVersion.findById(versionId);
  if (!version) throw new AppError('Version introuvable.', 404);
  if (version.statut === 'actif') {
    throw new AppError('Cette version est déjà active.', 400);
  }

  await PromptVersion.updateMany(
    { cible: version.cible, niche: version.niche, statut: 'actif' },
    { $set: { statut: 'archive' } }
  );

  version.statut = 'actif';
  version.decidePar = decidePar;
  version.decideAt = new Date();
  await version.save();

  console.log(`[prompts] Version ${version.version} restaurée pour ${version.cible} par ${decidePar}`);
  return version;
}

/**
 * Applique les candidats dont le délai de silence (1h) est écoulé.
 * À appeler périodiquement. Un refus explicite de l'admin l'emporte
 * toujours : seuls les candidats encore en attente sont concernés.
 */
export async function appliquerCandidatsExpires(): Promise<number> {
  const expires = await PromptVersion.find({
    statut: 'candidat',
    autoApplyAt: { $lte: new Date() },
  });

  let appliques = 0;
  for (const c of expires) {
    try {
      await appliquerCandidat(String(c._id), 'auto');
      appliques++;
    } catch (err) {
      console.error(`[prompts] Échec application automatique ${c._id} :`, err);
    }
  }
  return appliques;
}

/** Historique complet d'une cible, pour l'écran admin. */
export async function getHistoriquePrompts(cible: PromptCible, niche: string | null = null) {
  return PromptVersion.find({ cible, niche })
    .sort({ version: -1 })
    .limit(50)
    .lean();
}

/** Tous les candidats en attente de décision (badge admin). */
export async function getCandidatsEnAttente() {
  return PromptVersion.find({ statut: 'candidat' }).sort({ createdAt: -1 }).lean();
}
