// Agent de garde NexAI — passage de surveillance (toutes les 30 minutes, sur GitHub).
//
// 1. Vérifie lui-même le serveur (base + Redis) et le site, SANS passer par NexAI.
// 2. Serveur en panne (2 fois de suite) : remet la dernière version qui marchait
//    si un déploiement récent est en cause, sinon redémarre le serveur. Vérifie
//    ensuite, et ouvre un ticket GitHub (email au propriétaire).
// 3. Serveur sain : demande à NexAI les incidents confiés à l'agent. S'il y en a,
//    le travail de réparation (avec Claude) est lancé ; sinon, rien ne coûte.
import {
  serveurSain,
  siteRepond,
  nexai,
  deploiements,
  revenirAuDeploiement,
  redemarrer,
  ticket,
  sortie,
  attendre,
  journal,
  BACKEND,
  SITE,
} from './commun.mjs';

const RECENT_MS = 6 * 3600 * 1000;

async function reparerServeurEnPanne() {
  const liste = await deploiements();
  const iEnLigne = liste.findIndex((d) => d.status === 'live');
  const enLigne = iEnLigne >= 0 ? liste[iEnLigne] : null;
  // Version précédente qui a réellement tourné (« deactivated » = remplacée après avoir été en ligne).
  const precedent = iEnLigne >= 0 ? liste.slice(iEnLigne + 1).find((d) => d.status === 'deactivated') : null;
  const recent = enLigne?.finishedAt && Date.now() - new Date(enLigne.finishedAt).getTime() < RECENT_MS;

  let action;
  // Jamais deux retours en arrière d'affilée : si la version en ligne est déjà
  // un retour arrière, le code n'est pas en cause → on redémarre seulement.
  if (recent && precedent && enLigne?.trigger !== 'rollback') {
    await revenirAuDeploiement(precedent.id);
    action = `Déploiement récent en cause : retour à la version précédente (${precedent.id}, code ${precedent.commit?.id?.slice(0, 8) ?? '?'}).`;
  } else {
    await redemarrer();
    action = 'Aucun déploiement récent : redémarrage du serveur.';
  }
  journal(action);
  await attendre(5 * 60 * 1000);
  const ok = (await serveurSain()) || (await attendre(60_000), await serveurSain());
  ticket(
    ok ? 'Serveur NexAI : panne réparée automatiquement' : 'URGENT — Serveur NexAI toujours en panne',
    [
      `**${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}** — le serveur ne répondait plus (${BACKEND}).`,
      '',
      `Action de l'agent : ${action}`,
      '',
      ok
        ? '✅ Le serveur répond de nouveau (base de données et Redis compris).'
        : '❌ Le serveur ne répond toujours pas. Vérifiez Render (journaux, crédits, base MongoDB, Redis). L’agent réessaiera au prochain passage.',
    ].join('\n')
  );
}

async function main() {
  // Tant que l'agent n'est pas configuré (secrets GitHub), il ne fait rien et ne sonne pas.
  if (!BACKEND || !process.env.AGENT_TOKEN || !process.env.RENDER_API_KEY) {
    journal('Agent non configuré (BACKEND_URL, AGENT_TOKEN ou RENDER_API_KEY manquant) : rien à faire.');
    return;
  }
  // Deux essais espacés : un serveur gratuit endormi met jusqu'à une minute à répondre.
  let sain = await serveurSain();
  if (!sain) {
    await attendre(45_000);
    sain = await serveurSain();
  }

  if (!sain) {
    journal('Serveur en panne après 2 vérifications.');
    try {
      await reparerServeurEnPanne();
    } catch (e) {
      ticket('URGENT — Serveur NexAI en panne', `Le serveur ne répond plus et l'agent n'a pas pu agir sur Render : ${e.message}`);
    }
    process.exitCode = 1; // GitHub signale l'échec du passage par email.
    return;
  }

  if (!(await siteRepond())) {
    await attendre(30_000);
    if (!(await siteRepond())) {
      ticket('Site NexAI injoignable', `Le site ${SITE} ne répond pas alors que le serveur va bien. Vérifiez Netlify (déploiement, domaine).`);
    }
  }

  const { taches = [] } = await nexai('/tasks');
  if (!taches.length) {
    journal('Serveur sain, aucun incident à réparer.');
    return;
  }
  // Critiques d'abord ; une réparation à la fois pour ne jamais en superposer deux.
  const ordre = { critique: 0, moyenne: 1, faible: 2 };
  taches.sort((a, b) => (ordre[a.gravite] ?? 3) - (ordre[b.gravite] ?? 3));
  journal(`${taches.length} incident(s) à réparer ; prise en charge de ${taches[0].id}.`);
  sortie('tache', taches[0].id);
}

main().catch((e) => {
  journal('Erreur du passage de garde :', e.message);
  process.exitCode = 1;
});
