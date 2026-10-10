import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { PlatformAlert } from '@/models/PlatformAlert';

/**
 * Validation, par l'administrateur, d'une correction proposée par l'agent.
 *
 * C'est le SEUL moment où du nouveau code de l'agent part en ligne, et il
 * faut un clic de l'administrateur. Ensuite, l'agent (sur GitHub) contrôle
 * la mise en ligne pendant 5 minutes et remet la version d'avant si besoin.
 */
async function github(chemin: string, init: { method: string; body?: unknown }) {
  if (!env.GITHUB_AGENT_TOKEN) {
    throw new AppError('Validation depuis NexAI non configurée : validez la proposition directement sur GitHub (lien dans l’incident).', 400);
  }
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_DEPOT}${chemin}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_AGENT_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok && r.status !== 204) throw new AppError(`GitHub a refusé l’opération (${r.status}) : ${String(data.message ?? '')}`, 502);
  return data;
}

export async function validerProposition(incidentId: string, par: string): Promise<void> {
  const inc = await PlatformAlert.findById(incidentId);
  if (!inc) throw new AppError('Incident introuvable.', 404);
  if (inc.statut !== 'a_valider' || !inc.proposition?.numero) throw new AppError('Aucune correction en attente de validation.', 409);
  const fusion = await github(`/pulls/${inc.proposition.numero}/merge`, {
    method: 'PUT',
    body: { merge_method: 'squash', commit_title: `Agent : correction de l'incident ${incidentId} (validée par l'administrateur)` },
  });
  inc.commitValide = String(fusion.sha ?? '');
  inc.statut = 'en_reparation';
  inc.decidePar = par;
  inc.decideA = new Date();
  await inc.save();
  // L'agent contrôle la mise en ligne (5 minutes) et revient en arrière si besoin.
  await github('/actions/workflows/agent-garde.yml/dispatches', {
    method: 'POST',
    body: { ref: 'main', inputs: { verifier: incidentId } },
  });
}

export async function refuserProposition(incidentId: string): Promise<void> {
  const inc = await PlatformAlert.findById(incidentId);
  if (!inc?.proposition?.numero || !env.GITHUB_AGENT_TOKEN) return;
  await github(`/pulls/${inc.proposition.numero}`, { method: 'PATCH', body: { state: 'closed' } }).catch(() => undefined);
}
