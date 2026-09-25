import { AlerteQualite } from '@/models/AlerteQualite';
import { Site } from '@/models/Site';
import { callClaude } from '@/services/ai-clients';
import { logEvent } from '@/services/logs.service';
import { pipelineQueue } from '@/jobs/queue';
import { loadLibraryForNiche } from '@/services/library.service';

/**
 * Agent qualité Fable — alertes de génération PAYANTES uniquement
 * (Architecture v6, sections 4 et 18).
 *
 * Fable n'intervient jamais pendant la génération elle-même, ni sur les
 * comptes d'essai (coût non justifié sans garantie de conversion). Il
 * intervient ICI, une fois le site bloqué en attente : il relit le verdict
 * motivé des juges, examine le site réellement produit, puis tranche.
 *
 * Deux issues :
 *   · VALIDER — les problèmes signalés ne sont pas bloquants, le client
 *     reçoit son site.
 *   · REFUSER — les problèmes sont réellement graves, on relance une
 *     génération COMPLÈTEMENT NOUVELLE (autres composants, autre direction
 *     artistique) pour ne pas retomber exactement sur le même résultat.
 *
 * Priorité de décision : la décision de l'administrateur l'emporte TOUJOURS,
 * tant que celle de Fable n'a pas encore été exécutée. Une fois la relance
 * lancée ou le site livré, l'action est irréversible — c'est pour ça que
 * l'exécution et le marquage de l'alerte se font de façon atomique
 * (findOneAndUpdate conditionné au statut 'ouverte').
 */

/** Délai avant décision automatique (5 à 10 minutes — on prend 7 min). */
export const FABLE_DELAI_DECISION_MS = 3 * 60 * 1000; // 3 minutes

const PROMPT_FABLE_ALERTE = `Tu es Fable, l'agent qualité de NexAI. Un site généré pour un client PAYANT a été signalé par les juges automatiques et attend une décision.

Ton rôle : décider si le site peut être livré au client tel quel, ou s'il faut tout regénérer.

Critères de décision :
- VALIDER si les problèmes relevés sont cosmétiques, mineurs, ou si le site reste globalement professionnel et utilisable par le client.
- REFUSER seulement si le site présente un défaut réellement grave : structure cassée, contenu hors sujet par rapport à l'activité du client, rendu visuellement inacceptable pour un usage professionnel, ou élément manifestement manquant.

Le client a PAYÉ : un site correct mais perfectible vaut mieux qu'une attente supplémentaire. Ne refuse que si tu ne livrerais honnêtement pas ce site à un client payant.

Réponds UNIQUEMENT en JSON :
{"decision": "valider" | "refuser", "raison": "une phrase courte expliquant ta décision"}`;

interface DecisionFable {
  decision: 'valider' | 'refuser';
  raison: string;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()) as T;
  } catch {
    return null;
  }
}

/**
 * Relance une génération VOLONTAIREMENT DIFFÉRENTE : nouvelle direction
 * artistique et sélection de composants alternative. Sans ça, le pipeline
 * repartirait des mêmes choix et produirait très probablement le même
 * défaut — on tournerait en rond.
 */
async function relancerEnVariation(siteId: string, userId: string): Promise<string> {
  const site = await Site.findById(siteId);
  if (!site) throw new Error('Site introuvable pour la relance');

  // Pool de composants de la niche, pour proposer un agencement différent
  // de celui qui vient d'échouer.
  let composantsAlternatifs: string[] = [];
  try {
    const lib = await loadLibraryForNiche(site.niche);
    composantsAlternatifs = (lib?.components ?? [])
      .map((c) => {
        const comp = c as { _id?: string; id?: string };
        return comp._id ?? comp.id ?? '';
      })
      .filter(Boolean);
  } catch {
    // Non bloquant : sans pool alternatif, le seed suffit déjà à varier.
  }

  site.status = 'generating';
  site.proposals = [];
  await site.save();

  const job = await pipelineQueue.add('generate-site', {
    siteId: String(site._id),
    userId,
    // Le client a déjà payé cette génération : jamais de second débit.
    skipDebit: true,
    // Signale au pipeline qu'il doit produire une variation, pas une
    // reproduction : nouveau seed de direction artistique + pool de
    // composants à réagencer différemment.
    forceVariation: true,
    refabricationFable: true,
    seedOverride: `retry_${Date.now()}`,
    composantsAlternatifs,
  });

  return String(job.id);
}

/**
 * Demande à Fable de trancher sur une alerte payante en attente.
 * Exécution ATOMIQUE : si l'admin a tranché entre-temps, l'alerte n'est
 * plus 'ouverte' et Fable n'exécute rien — la décision humaine gagne.
 */
export async function fableDeciderSurAlerte(alerteId: string): Promise<{
  applique: boolean;
  decision?: 'valider' | 'refuser';
  raison?: string;
}> {
  const alerte = await AlerteQualite.findById(alerteId);
  if (!alerte) return { applique: false, raison: 'alerte_introuvable' };

  // L'admin a déjà tranché → sa décision prime, Fable s'abstient.
  if (alerte.statut !== 'ouverte') {
    return { applique: false, raison: 'deja_traitee_par_admin' };
  }
  if (alerte.type !== 'attente_action') {
    return { applique: false, raison: 'alerte_informative_essai' };
  }

  const site = await Site.findById(alerte.siteId);
  if (!site) return { applique: false, raison: 'site_introuvable' };

  // Contexte transmis à Fable : le verdict MOTIVÉ des juges et le site
  // réellement produit. Jamais le score (il n'est pas un motif de décision),
  // jamais la librairie complète.
  const verdicts = (alerte.verdictJuges ?? [])
    .map(
      (v) =>
        `Juge ${v.juge} — ${v.verdict}\nRaisons : ${(v.raisons ?? []).join(' · ') || 'non précisées'}\nConseils : ${(v.conseils ?? []).join(' · ') || 'non précisés'}`
    )
    .join('\n\n');

  const meilleure = (site.proposals ?? []).reduce(
    (best, p) => ((p.score ?? 0) > (best?.score ?? -1) ? p : best),
    site.proposals?.[0]
  );

  let decision: DecisionFable | null = null;
  try {
    const raw = await callClaude(
      'claude-fable-5-1',
      PROMPT_FABLE_ALERTE,
      [
        {
          role: 'user',
          content: `Niche : ${site.niche}
Plan du client : ${alerte.plan}
Brief du client : ${JSON.stringify(site.brief).slice(0, 1500)}

Verdict des juges :
${verdicts || 'Aucun verdict détaillé disponible.'}

Site généré (extrait HTML) :
${(meilleure?.htmlDemo ?? '').slice(0, 12000)}`,
        },
      ],
      { maxTokens: 600, temperature: 0.2 }
    );
    decision = parseJson<DecisionFable>(raw);
  } catch (err) {
    console.error('[fable] Appel échoué, alerte laissée à l\u2019admin :', err);
    await logEvent({
      categorie: 'alerte_qualite',
      niveau: 'error',
      message: `Fable indisponible — alerte laissée en attente de décision admin (niche ${alerte.niche})`,
      siteId: alerte.siteId,
    });
    return { applique: false, raison: 'fable_indisponible' };
  }

  if (!decision || (decision.decision !== 'valider' && decision.decision !== 'refuser')) {
    // Réponse reçue mais inexploitable : c'est un échec technique au même
    // titre qu'une panne, il compte donc dans le quota avant livraison.
    await AlerteQualite.updateOne({ _id: alerte._id }, { $inc: { echecsFable: 1 } });
    return { applique: false, raison: 'reponse_fable_invalide' };
  }

  // ── Exécution ATOMIQUE ────────────────────────────────────────
  // On ne bascule l'alerte que si elle est TOUJOURS 'ouverte'. Si l'admin
  // a cliqué pendant l'appel à Fable (plusieurs secondes), sa décision est
  // déjà enregistrée et celle de Fable est abandonnée.
  const verrou = await AlerteQualite.findOneAndUpdate(
    { _id: alerte._id, statut: 'ouverte' },
    {
      statut: decision.decision === 'valider' ? 'validee' : 'refusee',
      traitePar: 'fable',
      traiteA: new Date(),
    },
    { new: true }
  );

  if (!verrou) {
    return { applique: false, raison: 'admin_a_tranche_entre_temps' };
  }

  if (decision.decision === 'valider') {
    site.status = 'ready';
    await site.save();
    await logEvent({
      categorie: 'alerte_qualite',
      niveau: 'info',
      message: `Fable a validé la livraison — ${decision.raison}`,
      siteId: site._id,
      userId: alerte.userId,
    });
  } else {
    const jobId = await relancerEnVariation(String(site._id), String(alerte.userId));
    verrou.relanceJobId = jobId;
    await verrou.save();
    await logEvent({
      categorie: 'alerte_qualite',
      niveau: 'warn',
      message: `Fable a refusé et relancé une génération en variation — ${decision.raison}`,
      siteId: site._id,
      userId: alerte.userId,
      contexte: { jobId },
    });
  }

  return { applique: true, decision: decision.decision, raison: decision.raison };
}

/**
 * Balaie les alertes payantes dont le délai de décision est écoulé et
 * demande à Fable de trancher. Appelé périodiquement par le worker.
 */
export async function traiterAlertesEnAttente(): Promise<number> {
  const limite = new Date(Date.now() - FABLE_DELAI_DECISION_MS);
  const alertes = await AlerteQualite.find({
    statut: 'ouverte',
    type: 'attente_action',
    createdAt: { $lte: limite },
  })
    .limit(20)
    .select('_id');

  let traitees = 0;
  for (const a of alertes) {
    const res = await fableDeciderSurAlerte(String(a._id));
    if (res.applique) traitees++;
  }
  return traitees;
}

/**
 * Filet de sécurité : un client PAYANT ne doit jamais rester sans aperçu.
 *
 * Le fonctionnement normal est que Fable tranche au bout de 7 minutes
 * (valider, ou refuser et relancer). Mais si Fable est indisponible
 * durablement (panne API, quota épuisé, réponse invalide en boucle),
 * l'alerte resterait ouverte et le client n'aurait JAMAIS rien reçu — ce
 * qui est bien pire qu'un site imparfait.
 *
 * Passé ce délai de secours, on livre donc le site tel quel avec le badge
 * « Meilleure version » : principe « jamais 0 aperçu » de l'Architecture v6.
 */
export const DELAI_LIVRAISON_SECOURS_MS = 6 * 60 * 1000; // 6 minutes

/**
 * Nombre d'échecs techniques de Fable après lequel on livre sans attendre
 * la fin du délai. Un client payant ne doit jamais patienter à cause d'une
 * panne d'API : deux tentatives ratées suffisent à conclure que Fable ne
 * répondra pas maintenant.
 */
export const MAX_ECHECS_FABLE = 2;

export async function livrerAlertesBloquees(): Promise<number> {
  const limite = new Date(Date.now() - DELAI_LIVRAISON_SECOURS_MS);
  const bloquees = await AlerteQualite.find({
    statut: 'ouverte',
    type: 'attente_action',
    // Délai écoulé OU Fable a échoué techniquement plusieurs fois : dans
    // les deux cas, inutile de faire attendre le client davantage.
    $or: [
      { createdAt: { $lte: limite } },
      { echecsFable: { $gte: MAX_ECHECS_FABLE } },
    ],
  }).limit(20);

  let livrees = 0;
  for (const alerte of bloquees) {
    const site = await Site.findById(alerte.siteId);
    if (!site) continue;

    site.status = 'ready';
    await site.save();

    alerte.statut = 'validee';
    alerte.traitePar = 'systeme';
    alerte.traiteA = new Date();
    await alerte.save();

    await logEvent({
      categorie: 'alerte_qualite',
      niveau: 'warn',
      message: `Livraison de secours — aucune décision dans le délai imparti (niche ${alerte.niche}). Site livré au client avec badge « Meilleure version ».`,
      siteId: site._id,
      userId: alerte.userId,
    });
    livrees++;
  }
  return livrees;
}
