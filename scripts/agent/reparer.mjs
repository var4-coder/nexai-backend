// Agent de garde NexAI — correction d'un incident, VALIDÉE par l'administrateur.
//
//   node reparer.mjs preparer <id>  → note le point de retour, prend l'incident,
//                                     écrit .agent/incident.md pour Claude
//   (Claude prépare la correction, sans commit — voir CONSIGNES.md)
//   node reparer.mjs proposer <id>  → contrôle la correction (fichiers autorisés,
//                                     compilation) et la soumet comme PROPOSITION
//                                     sur une branche à part. Rien n'est mis en ligne.
//   node reparer.mjs verifier <id>  → après validation par l'admin : attend la mise
//                                     en ligne, contrôle 5 minutes, et remet la
//                                     version d'avant si ça se passe mal.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  nexai,
  sh,
  deploiements,
  deploiementEnLigne,
  revenirAuDeploiement,
  serveurSain,
  attendre,
  journal,
  ticket,
} from './commun.mjs';

const [, , etape, id] = process.argv;
if (!id) throw new Error('Identifiant d’incident manquant');
const DOSSIER = '.agent';

/** Fichiers que l'agent n'a JAMAIS le droit de modifier : paiements, crédits, sécurité, configuration, lui-même. */
const INTERDITS = [
  /^src\/services\/chariow/,
  /^src\/services\/credits\.service/,
  /^src\/services\/auth\.service/,
  /^src\/services\/securite/,
  /^src\/middleware\/(auth|securite)/,
  /^src\/config\//,
  /^src\/models\//,
  /^src\/routes\/(auth|admin|platform-agent)\.routes/,
  /^scripts\/agent\//,
  /^\.github\//,
  /^package(-lock)?\.json$/,
  /^Dockerfile$/,
  /\.env/,
];
const MAX_FICHIERS = 8;

async function rapport(resolu, compteRendu, retourArriere = false) {
  await nexai(`/tasks/${id}/report`, { methode: 'POST', corps: { resolu, compteRendu: compteRendu.slice(0, 3900), retourArriere } });
}

async function preparer() {
  const { taches = [] } = await nexai('/tasks');
  const t = taches.find((x) => x.id === id);
  if (!t) throw new Error('Incident plus dans la file (déjà pris ou annulé)');

  // Point de retour : la version exacte qui tourne MAINTENANT.
  const commitServeur = sh('git rev-parse HEAD');
  const live = await deploiementEnLigne();
  await nexai(`/tasks/${id}/start`, {
    methode: 'POST',
    corps: { pointDeRetour: { commitServeur, ...(live ? { deployServeur: live.id } : {}) } },
  });
  journal('Point de retour noté :', commitServeur, live?.id ?? '(déploiement inconnu)');

  mkdirSync(DOSSIER, { recursive: true });
  writeFileSync(
    `${DOSSIER}/incident.md`,
    [
      `# Incident ${t.id} (${t.gravite})`,
      `- Zone : ${t.composant}${t.contexte ? ` — ${t.contexte}` : ''}`,
      `- Occurrences : ${t.occurrences}`,
      '',
      '## Erreur',
      '```',
      String(t.erreur).slice(0, 3000),
      '```',
      t.stack ? `## Pile d'appel\n\`\`\`\n${String(t.stack).slice(0, 3000)}\n\`\`\`` : '',
      t.causeProbable ? `## Cause probable (diagnostic NexAI)\n${t.causeProbable}` : '',
      t.pisteCorrection ? `## Piste de correction\n${t.pisteCorrection}` : '',
      t.fichiersSuspects?.length ? `## Fichiers suspects\n${t.fichiersSuspects.map((f) => `- ${f}`).join('\n')}` : '',
    ].join('\n')
  );
}

async function proposer() {
  const noteClaude = existsSync(`${DOSSIER}/rapport.md`) ? readFileSync(`${DOSSIER}/rapport.md`, 'utf8').trim() : '';
  const modifies = sh('git status --porcelain')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.startsWith(`${DOSSIER}/`));

  if (!modifies.length) {
    await rapport(false, noteClaude || 'Aucune correction de code proposée : la cause semble extérieure au code (fournisseur, clé, crédits, configuration).');
    return;
  }
  const interdits = modifies.filter((f) => INTERDITS.some((r) => r.test(f)));
  if (interdits.length || modifies.length > MAX_FICHIERS) {
    await rapport(
      false,
      `Aucune proposition : la correction touchait ${interdits.length ? `des fichiers protégés (${interdits.join(', ')})` : `trop de fichiers (${modifies.length})`}. Décision de l'administrateur requise.\n\n${noteClaude}`
    );
    return;
  }
  try {
    sh('npm run build', { maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    await rapport(false, `Aucune proposition : le projet ne compile plus avec la correction.\n${String(e.stdout || e.message).slice(-1500)}`);
    return;
  }

  // Proposition sur une branche à part : RIEN n'est mis en ligne sans validation.
  const branche = `agent/incident-${id}`;
  sh('git config user.name "Agent de garde NexAI" && git config user.email "agent@nexai.local"');
  sh(`git checkout -b ${branche}`);
  sh(`git add -- ${modifies.map((f) => JSON.stringify(f)).join(' ')}`);
  sh(`git commit -m ${JSON.stringify(`Agent : correction proposée pour l'incident ${id}`)}`);
  sh(`git push --force origin ${branche}`);
  const corps = [
    `Correction proposée par l'agent de garde pour l'incident \`${id}\`.`,
    'Elle n’est PAS en ligne : à valider depuis l’administration NexAI (Sécurité & Maintenance).',
    '',
    noteClaude || '(pas de compte-rendu)',
    '',
    `Fichiers modifiés : ${modifies.join(', ')}`,
  ].join('\n');
  const url = sh(
    `gh pr create --base main --head ${branche} --title ${JSON.stringify(`Agent : correction de l'incident ${id}`)} --body-file -`,
    { input: corps, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const numero = Number(url.split('/').pop());
  await nexai(`/tasks/${id}/proposition`, {
    methode: 'POST',
    corps: { url, numero, resume: (noteClaude || 'Correction proposée.').slice(0, 3500), fichiers: modifies },
  });
  journal('Proposition soumise :', url);
}

async function annulerEnLigne(raison, deployAvant, commitFusion) {
  if (deployAvant) await revenirAuDeploiement(deployAvant).catch((e) => journal('Retour Render impossible :', e.message));
  // Le code de « main » redevient celui d'avant, sans redéployer (déjà fait ci-dessus).
  sh('git config user.name "Agent de garde NexAI" && git config user.email "agent@nexai.local"');
  sh('git fetch origin main && git checkout main && git reset --hard origin/main');
  if (sh('git rev-parse HEAD') === commitFusion) {
    sh('git revert --no-edit HEAD');
    sh('git commit --amend -m "Agent : retour à la version d’avant (correction annulée) [skip render]"');
    sh('git push origin HEAD:main');
  }
  await rapport(false, `Correction validée puis annulée : tout est revenu comme avant. Raison : ${raison}`, true);
}

/** Après validation par l'admin : contrôle la mise en ligne et revient en arrière si besoin. */
async function verifier() {
  const etat = await nexai(`/tasks/${id}/etat`);
  const commit = etat.commitValide;
  const avant = etat.pointDeRetour?.deployServeur;
  if (!commit) throw new Error('Aucune correction validée pour cet incident');

  let deploy = null;
  for (let i = 0; i < 60; i++) {
    await attendre(20_000);
    const d = (await deploiements(10)).find((x) => x.commit?.id === commit);
    if (!d) continue;
    if (d.status === 'live') {
      deploy = d;
      break;
    }
    if (/failed|canceled/.test(d.status)) {
      await annulerEnLigne(`le déploiement a échoué sur Render (${d.status}) ; l'ancienne version n'a jamais cessé de tourner`, null, commit);
      return;
    }
  }
  if (!deploy) {
    await annulerEnLigne('mise en ligne trop longue (plus de 20 minutes)', avant, commit);
    return;
  }
  await nexai(`/tasks/${id}/en-ligne`, { methode: 'POST', corps: { commitServeur: commit, deployServeur: deploy.id } });

  // Double vérification : 5 minutes de contrôles réels (serveur, base, Redis).
  let echecs = 0;
  for (let i = 0; i < 10; i++) {
    await attendre(30_000);
    if (!(await serveurSain(30_000))) echecs += 1;
  }
  if (echecs >= 2) {
    await annulerEnLigne(`le serveur a mal répondu ${echecs} fois sur 10 après la correction`, avant, commit);
    return;
  }
  const apres = await nexai(`/tasks/${id}/etat`);
  if (apres.enLigneA && new Date(apres.derniereOccurrence) > new Date(apres.enLigneA)) {
    await annulerEnLigne('l’erreur s’est reproduite après la correction', avant, commit);
    return;
  }
  await rapport(true, `Correction validée, mise en ligne et vérifiée (5 minutes de contrôles, aucune nouvelle occurrence). Code ${commit.slice(0, 8)}.`);
}

const etapes = { preparer, proposer, verifier };
if (!etapes[etape]) throw new Error(`Étape inconnue : ${etape}`);
etapes[etape]().catch(async (e) => {
  journal('Échec :', e.message);
  ticket(
    `Agent de garde : étape « ${etape} » interrompue (${id})`,
    `L'agent s'est arrêté sur une erreur : ${e.message}\n\nVoir l'incident dans l'administration ; le bouton « Revenir à la version d’avant » reste disponible.`
  );
  if (etape !== 'preparer') await rapport(false, `Étape « ${etape} » interrompue : ${e.message}`).catch(() => undefined);
  process.exitCode = 1;
});
