import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { PlatformAlert } from '@/models/PlatformAlert';

/**
 * « Revenir à la version d'avant » : remet en ligne exactement la version
 * notée par l'agent AVANT sa réparation (point de retour).
 *  · Serveur : retour arrière Render vers le déploiement d'avant.
 *  · Site : restauration Netlify du déploiement d'avant.
 * Rien n'est supprimé : la version de l'agent reste dans l'historique et
 * peut être remise plus tard.
 */
export async function revenirVersionAvant(incidentId: string, par: 'admin' | 'agent'): Promise<string[]> {
  const inc = await PlatformAlert.findById(incidentId);
  if (!inc) throw new AppError('Incident introuvable.', 404);
  const point = inc.pointDeRetour;
  if (!point?.deployServeur && !point?.deploySite) {
    throw new AppError('Aucun point de retour enregistré pour cet incident : rien à annuler.', 400);
  }
  const fait: string[] = [];
  const aFaire: string[] = [];

  if (point.deployServeur) {
    if (env.RENDER_API_KEY && env.RENDER_SERVICE_ID) {
      const r = await fetch(`https://api.render.com/v1/services/${env.RENDER_SERVICE_ID}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ deployId: point.deployServeur }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new AppError(`Retour arrière du serveur refusé par Render (${r.status}).`, 502);
      fait.push(`Serveur remis sur la version ${point.deployServeur}`);
    } else {
      aFaire.push(`Serveur : Render → nexai-backend → Events → déploiement ${point.deployServeur} → « Rollback ».`);
    }
  }
  if (point.deploySite) {
    if (env.NETLIFY_ACCESS_TOKEN && env.NETLIFY_SITE_ID_NEXAI) {
      const r = await fetch(
        `https://api.netlify.com/api/v1/sites/${env.NETLIFY_SITE_ID_NEXAI}/deploys/${point.deploySite}/restore`,
        { method: 'POST', headers: { Authorization: `Bearer ${env.NETLIFY_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(20_000) }
      );
      if (!r.ok) throw new AppError(`Restauration du site refusée par Netlify (${r.status}).`, 502);
      fait.push(`Site remis sur la version ${point.deploySite}`);
    } else {
      aFaire.push(`Site : Netlify → nexaites → Deploys → déploiement ${point.deploySite} → « Publish deploy ».`);
    }
  }

  inc.retourArriere = { par, le: new Date(), detail: [...fait, ...aFaire].join(' · ') };
  if (fait.length && !aFaire.length) inc.statut = 'diagnostique';
  await inc.save();
  return [...fait, ...aFaire.map((x) => `À faire : ${x}`)];
}
