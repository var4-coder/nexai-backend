import crypto from 'crypto';
import { PlatformAlert, IncidentGravite } from '@/models/PlatformAlert';
import { sendIncidentSerieuxEmail } from '@/services/brevo.service';
import { callClaude } from '@/services/ai-clients';
import { env } from '@/config/env';

/**
 * Incidents plateforme — détection et diagnostic (Architecture v6, section 3).
 *
 * Fable détecte la cause racine, Sonnet rédige la piste de correction :
 * Sonnet coûte 2$/10$ par million de tokens contre 10$/50$ pour Fable,
 * soit 5× moins cher pour un travail de rédaction. Même répartition que
 * pour le diagnostic des prompts.
 *
 * Aucune modification automatique du code : le diagnostic est présenté à
 * l'administrateur, qui décide. La réparation est exécutée par son agent
 * externe (compte Console, accès Git), jamais par ce backend.
 */

const PROMPT_FABLE = `Tu es l'agent de maintenance de NexAI, une plateforme SaaS Node.js/Express/TypeScript
avec MongoDB, Redis/BullMQ, déployée sur Render (un service web + un worker séparé).

On te transmet une erreur survenue en production. Identifie la CAUSE RACINE, pas le symptôme.

Structure du projet :
- src/routes/*.routes.ts — points d'entrée HTTP
- src/services/*.service.ts — logique métier (génération de sites, vidéos, crédits, IA)
- src/jobs/worker.ts — traitements asynchrones (génération, vidéo, déploiement)
- src/models/*.ts — schémas Mongoose
- Intégrations : Anthropic, xAI, Cloudinary, GoDaddy, Netlify, FalAI, Alexya, ElevenLabs, Chariow, Brevo

Évalue aussi la gravité :
- "critique" : la plateforme ou une fonction payante est hors service
- "moyenne" : une fonction dégradée, contournable
- "faible" : incident isolé, sans impact client

Réponds UNIQUEMENT en JSON :
{"gravite":"faible|moyenne|critique","cause_probable":"...","fichiers_suspects":["src/..."],"piste_correction":"..."}`;

/**
 * Type de panne d'un fournisseur extérieur : « anthropic:credit »,
 * « xai:panne »… Toutes les erreurs du même type forment UN SEUL incident,
 * quelle que soit la fonction touchée (chat, codeur, juge…) et quel que soit
 * le détail du message (identifiant de requête, horodatage…).
 * Renvoie null pour une erreur qui ne vient pas d'un fournisseur.
 */
export function typeDePanne(erreur: string): string | null {
  const t = erreur.toLowerCase();
  const fournisseurs: [string, RegExp][] = [
    ['anthropic', /anthropic|claude-/],
    ['xai', /\bxai\b|x\.ai|grok-/],
    ['recraft', /recraft/],
    ['fal', /fal\.ai|falai|\bfal\b|kling/],
    ['alexya', /alexya/],
    ['elevenlabs', /elevenlabs/],
    ['gemini', /gemini/],
    ['cloudinary', /cloudinary/],
    ['netlify', /netlify/],
    ['godaddy', /godaddy/],
    ['porkbun', /porkbun/],
    ['brevo', /brevo/],
    ['chariow', /chariow/],
    ['bunny', /bunny/],
    ['mongodb', /mongo/],
    ['redis', /redis|bullmq/],
  ];
  // Le fournisseur cité EN PREMIER est celui qui a échoué (« claude-haiku
  // indisponible… basculé sur grok-4.6 » concerne Anthropic).
  let meilleur: { nom: string; pos: number } | null = null;
  for (const [nom, re] of fournisseurs) {
    const m = re.exec(t);
    if (m && (!meilleur || m.index < meilleur.pos)) meilleur = { nom, pos: m.index };
  }
  if (!meilleur) return null;
  const nature = /credit balance|insufficient|quota|billing|payment required|\b402\b|solde/.test(t)
    ? 'credit'
    : /api[_ -]?key|manquante|\b401\b|\b403\b|authenticat|unauthori|forbidden/.test(t)
      ? 'cle'
      : /\b429\b|rate.?limit|overloaded|\b529\b|satur/.test(t)
        ? 'saturation'
        : 'panne';
  return `${meilleur.nom}:${nature}`;
}

function empreinteDe(composant: string, erreur: string, contexte?: string): string {
  const type = typeDePanne(erreur);
  if (type) {
    return crypto.createHash('sha1').update(`fournisseur|${type}`).digest('hex').slice(0, 24);
  }
  // Les identifiants et nombres variables sont retirés : deux occurrences
  // du même bug ne doivent produire qu'un seul incident.
  const normalise = erreur
    .replace(/[0-9a-f]{24}/gi, 'ID')
    .replace(/\d+/g, 'N')
    .slice(0, 300);
  return crypto
    .createHash('sha1')
    .update(`${composant}|${contexte ?? ''}|${normalise}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Signale un incident. Déduplique automatiquement : une erreur qui boucle
 * incrémente un compteur au lieu de créer des centaines d'entrées.
 * Ne lève jamais d'erreur — signaler un incident ne doit pas en provoquer un.
 */
export async function signalerIncident(params: {
  composant: string;
  erreur: string;
  stack?: string;
  contexte?: string;
  gravite?: IncidentGravite;
  /**
   * Qui doit s'en occuper. Par défaut 'serieuse' : une panne qu'on ne sait
   * pas classer mérite un regard humain plutôt qu'un silence.
   */
  categorie?: 'fable' | 'serieuse';
}): Promise<void> {
  try {
    const empreinte = empreinteDe(params.composant, params.erreur, params.contexte);

    // Même panne encore ouverte (pas « résolue ») : on compte, sans nouvelle
    // alerte ni nouvel email. L'administrateur a déjà été prévenu.
    const ouvert = await PlatformAlert.findOneAndUpdate(
      { empreinte, statut: { $ne: 'resolu' } },
      { $inc: { occurrences: 1 }, $set: { derniereOccurrence: new Date() } },
      { new: true }
    );
    if (ouvert) return;

    // La même panne revient APRÈS avoir été marquée résolue : c'est une
    // nouvelle panne, l'incident est rouvert et l'administrateur prévenu.
    const rouvert = await PlatformAlert.findOneAndUpdate(
      { empreinte, statut: 'resolu' },
      {
        $set: {
          statut: 'nouveau',
          occurrences: 1,
          derniereOccurrence: new Date(),
          erreur: params.erreur.slice(0, 2000),
          contexte: params.contexte,
          gravite: params.gravite ?? 'moyenne',
        },
        $unset: { resoluA: 1, causeProbable: 1, pisteCorrection: 1, diagnostiqueA: 1 },
      },
      { new: true }
    );

    const alerte =
      rouvert ??
      (await PlatformAlert.create({
      composant: params.composant,
      erreur: params.erreur.slice(0, 2000),
      stack: params.stack?.slice(0, 4000),
      contexte: params.contexte,
      gravite: params.gravite ?? 'moyenne',
      categorie: params.categorie ?? 'serieuse',
      empreinte,
      statut: 'nouveau',
    }).catch(async (e: { code?: number }) => {
      // Deux signalements simultanés de la même panne : l'autre a gagné.
      if (e?.code === 11000) return null;
      throw e;
    }));
    if (!alerte) return;

    // Panne sérieuse : email immédiat. L'administrateur doit pouvoir agir
    // sans être connecté à son espace. Une seule alerte par panne, quel que
    // soit le nombre de clients touchés (voir l'empreinte ci-dessus).
    if ((params.categorie ?? 'serieuse') === 'serieuse') {
      sendIncidentSerieuxEmail({
        composant: params.composant,
        erreur: params.erreur.slice(0, 600),
        contexte: params.contexte,
        gravite: params.gravite ?? 'moyenne',
        alerteId: String(alerte._id),
      }).catch((e) => console.error('[incident] Email panne sérieuse échoué :', e));
    }

    // Diagnostic en tâche de fond : ne bloque pas la requête en cours.
    diagnostiquerIncident(String(alerte._id)).catch((e) =>
      console.error('[incident] Diagnostic échoué :', e)
    );
  } catch (err) {
    console.error('[incident] Signalement échoué (non bloquant) :', err);
  }
}

/** Fait analyser un incident par Fable, puis notifie l'administrateur. */
export async function diagnostiquerIncident(alerteId: string): Promise<void> {
  const alerte = await PlatformAlert.findById(alerteId);
  if (!alerte || alerte.statut !== 'nouveau') return;

  try {
    const brut = await callClaude(
      'claude-opus-5-5',
      PROMPT_FABLE,
      [
        {
          role: 'user',
          content: `Composant : ${alerte.composant}
Contexte : ${alerte.contexte ?? '(non précisé)'}
Occurrences : ${alerte.occurrences}

Erreur :
${alerte.erreur}

Pile d'appel :
${alerte.stack ?? '(indisponible)'}`,
        },
      ],
      { maxTokens: 1200, temperature: 0.2 }
    );

    const json = JSON.parse(brut.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());

    alerte.gravite = ['faible', 'moyenne', 'critique'].includes(json.gravite)
      ? json.gravite
      : alerte.gravite;
    alerte.causeProbable = String(json.cause_probable ?? '').slice(0, 1500);
    alerte.pisteCorrection = String(json.piste_correction ?? '').slice(0, 2000);
    alerte.fichiersSuspects = Array.isArray(json.fichiers_suspects)
      ? json.fichiers_suspects.slice(0, 8).map(String)
      : [];
    alerte.statut = 'diagnostique';
    alerte.diagnostiqueA = new Date();
    await alerte.save();

    if (env.ADMIN_EMAIL) {
      const { sendPlatformIncidentEmail } = await import('@/services/brevo.service');
      await sendPlatformIncidentEmail({
        to: env.ADMIN_EMAIL,
        gravite: alerte.gravite,
        composant: alerte.composant,
        erreur: alerte.erreur,
        causeProbable: alerte.causeProbable ?? '',
        pisteCorrection: alerte.pisteCorrection ?? '',
      });
    }
  } catch (err) {
    console.error('[incident] Fable indisponible pour le diagnostic :', err);
  }
}

/**
 * File de travail de l'agent externe : uniquement les incidents que
 * l'administrateur a explicitement approuvés. Aucune réparation ne peut
 * démarrer sans cette approbation.
 */
export async function getTachesApprouvees() {
  const taches = await PlatformAlert.find({ statut: 'approuve' })
    .sort({ gravite: 1, derniereOccurrence: -1 })
    .limit(20)
    .lean();

  return taches.map((t) => ({
    id: String(t._id),
    gravite: t.gravite,
    composant: t.composant,
    contexte: t.contexte ?? null,
    erreur: t.erreur,
    stack: t.stack ?? null,
    occurrences: t.occurrences,
    causeProbable: t.causeProbable ?? null,
    pisteCorrection: t.pisteCorrection ?? null,
    fichiersSuspects: t.fichiersSuspects ?? [],
  }));
}
