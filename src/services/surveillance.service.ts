import { env } from '@/config/env';
import { redisConnection } from '@/config/redis';
import { PlatformAlert } from '@/models/PlatformAlert';
import { Site } from '@/models/Site';
import { signalerIncident } from '@/services/platform-alert.service';
import { sendAgentNotificationEmail } from '@/services/brevo.service';

/**
 * Surveillance et intervention automatique (décision du 10/10/2026).
 *
 * 1. Sans réponse de l'administrateur, un incident diagnostiqué est confié
 *    à son agent de maintenance : après 30 minutes s'il est critique, après
 *    2 heures s'il est moyen. Les incidents faibles attendent toujours une
 *    décision. Au plus 2 interventions automatiques par incident.
 * 2. Surveillance par simple programme (sans IA, donc gratuite) :
 *    le site NexAI toutes les 5 minutes, les sites clients en ligne toutes
 *    les 30 minutes. Deux échecs de suite créent un incident.
 */

const DELAI_CRITIQUE_MS = 30 * 60 * 1000;
const DELAI_MOYENNE_MS = 2 * 60 * 60 * 1000;
const MAX_INTERVENTIONS_AUTO = 2;

export async function confierIncidentsSansReponse(): Promise<number> {
  const maintenant = Date.now();
  const candidats = await PlatformAlert.find({
    statut: 'diagnostique',
    categorie: 'serieuse',
    gravite: { $in: ['critique', 'moyenne'] },
    $or: [{ essaisAgent: { $exists: false } }, { essaisAgent: { $lt: MAX_INTERVENTIONS_AUTO } }],
  })
    .limit(20)
    .lean();
  let confies = 0;
  for (const inc of candidats) {
    const depuis = new Date(inc.diagnostiqueA ?? inc.updatedAt ?? inc.createdAt).getTime();
    const delai = inc.gravite === 'critique' ? DELAI_CRITIQUE_MS : DELAI_MOYENNE_MS;
    if (maintenant - depuis < delai) continue;
    const maj = await PlatformAlert.findOneAndUpdate(
      { _id: inc._id, statut: 'diagnostique' },
      { $set: { statut: 'approuve', approbationAuto: true, decidePar: 'automatique', decideA: new Date() } },
      { new: true }
    );
    if (!maj) continue;
    confies += 1;
    sendAgentNotificationEmail({
      titre: 'Pas de réponse : l’agent intervient seul',
      texte: `L’incident « ${inc.composant} » (${inc.gravite}) attend depuis ${
        inc.gravite === 'critique' ? '30 minutes' : '2 heures'
      }. Il vient d’être confié à votre agent de maintenance. Vous pouvez annuler sa réparation depuis l’administration.`,
      alerteId: String(inc._id),
    }).catch(() => undefined);
  }
  return confies;
}

/** N'exécute la tâche qu'une fois par intervalle, même si le balayage tourne plus souvent. */
async function unePar(cle: string, secondes: number): Promise<boolean> {
  const ok = await redisConnection.set(`surveillance:${cle}`, '1', 'EX', secondes, 'NX').catch(() => null);
  return ok === 'OK';
}

async function repond(url: string): Promise<boolean> {
  for (const methode of ['HEAD', 'GET'] as const) {
    try {
      const r = await fetch(url, { method: methode, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (r.status < 500) return true;
    } catch {
      /* essai suivant */
    }
  }
  return false;
}

/** Deux échecs de suite (le premier peut être un simple raté réseau). */
async function echecConfirme(cle: string, ok: boolean): Promise<boolean> {
  const k = `surveillance:echec:${cle}`;
  if (ok) {
    await redisConnection.del(k).catch(() => undefined);
    return false;
  }
  const n = await redisConnection.incr(k).catch(() => 0);
  await redisConnection.expire(k, 3 * 3600).catch(() => undefined);
  return n >= 2;
}

export async function surveiller(): Promise<void> {
  // Site NexAI (tableau de bord et pages publiques).
  if (await unePar('nexai', 5 * 60 - 10)) {
    const ok = await repond(env.CLIENT_URL);
    if (await echecConfirme('nexai', ok)) {
      await signalerIncident({
        composant: 'site-nexai',
        erreur: `Le site NexAI ne répond plus (${env.CLIENT_URL}).`,
        contexte: 'surveillance',
        gravite: 'critique',
        categorie: 'serieuse',
      });
    }
  }

  // Sites clients en ligne.
  if (await unePar('sites-clients', 30 * 60 - 10)) {
    const sites = await Site.find({ status: 'launched' }).select('domainName subdomainSlug name').limit(2000).lean();
    const enPanne: { id: string; hote: string }[] = [];
    // Par lots de 10, pour ne pas mettre des heures sur un grand nombre de sites.
    for (let i = 0; i < sites.length; i += 10) {
      await Promise.all(
        sites.slice(i, i + 10).map(async (s) => {
          const hote = s.domainName || (s.subdomainSlug ? `${s.subdomainSlug}.${env.NEXAI_SUBDOMAIN_BASE_DOMAIN}` : '');
          if (!hote) return;
          const ok = await repond(`https://${hote}`);
          if (await echecConfirme(`site:${s._id}`, ok)) enPanne.push({ id: String(s._id), hote });
        })
      );
    }
    // Beaucoup de sites tombés en même temps = panne commune (hébergeur,
    // DNS) : UN seul incident, pas un par site (ni des dizaines d'emails).
    if (enPanne.length > 3) {
      await signalerIncident({
        composant: 'sites-clients',
        erreur: `${enPanne.length} sites clients ne répondent plus (ex. ${enPanne
          .slice(0, 5)
          .map((x) => x.hote)
          .join(', ')}). Probable panne commune (hébergement ou DNS).`,
        contexte: 'surveillance:sites-clients',
        gravite: 'critique',
        categorie: 'serieuse',
      });
    } else {
      for (const x of enPanne) {
        await signalerIncident({
          composant: 'site-client',
          erreur: `Le site client ${x.hote} ne répond plus.`,
          contexte: `site:${x.id}`,
          gravite: 'moyenne',
          categorie: 'serieuse',
        });
      }
    }
  }
}
