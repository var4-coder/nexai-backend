// Outils partagés de l'agent de garde NexAI (exécuté sur GitHub, hors de NexAI).
// Aucune dépendance : Node 22 seulement.
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const BACKEND = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
export const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const RENDER = 'https://api.render.com/v1';

export const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
export const journal = (...m) => console.log(`[agent ${new Date().toISOString()}]`, ...m);

export function sortie(nom, valeur) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${nom}=${valeur}\n`);
}

export function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

/** Le serveur répond-il, base de données et Redis compris ? (délai long : serveur endormi) */
export async function serveurSain(timeoutMs = 90_000) {
  try {
    const r = await fetch(`${BACKEND}/api/v1/health/complet`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function siteRepond(timeoutMs = 60_000) {
  if (!SITE) return true;
  try {
    const r = await fetch(SITE, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Appel à l'API agent de NexAI (jeton dédié, jamais le compte admin). */
export async function nexai(chemin, { methode = 'GET', corps } = {}) {
  const r = await fetch(`${BACKEND}/api/v1/platform-agent${chemin}`, {
    method: methode,
    headers: { 'x-agent-token': process.env.AGENT_TOKEN || '', 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`NexAI ${chemin} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function render(chemin, { methode = 'GET', corps } = {}) {
  if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) throw new Error('Clé Render absente');
  const r = await fetch(`${RENDER}${chemin}`, {
    method: methode,
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Render ${chemin} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** Derniers déploiements du serveur, du plus récent au plus ancien. */
export async function deploiements(limite = 15) {
  const liste = await render(`/services/${process.env.RENDER_SERVICE_ID}/deploys?limit=${limite}`);
  return liste.map((x) => x.deploy ?? x);
}

export async function deploiementEnLigne() {
  return (await deploiements()).find((d) => d.status === 'live') ?? null;
}

export async function revenirAuDeploiement(deployId) {
  journal('Retour arrière Render vers', deployId);
  return render(`/services/${process.env.RENDER_SERVICE_ID}/rollback`, { methode: 'POST', corps: { deployId } });
}

export async function redemarrer() {
  journal('Redémarrage du serveur Render');
  return render(`/services/${process.env.RENDER_SERVICE_ID}/restart`, { methode: 'POST' });
}

/** Ouvre (ou complète) un ticket GitHub : GitHub prévient le propriétaire par email. */
export function ticket(titre, texte) {
  try {
    const existant = sh(`gh issue list --label agent-garde --state open --search ${JSON.stringify(`"${titre}" in:title`)} --json number --jq '.[0].number'`);
    if (existant) {
      sh(`gh issue comment ${existant} --body-file -`, { input: texte, stdio: ['pipe', 'pipe', 'pipe'] });
      return;
    }
    try {
      sh('gh label create agent-garde --color B60205 --description "Agent de garde NexAI"');
    } catch {
      /* déjà créé */
    }
    sh(`gh issue create --label agent-garde --title ${JSON.stringify(titre)} --body-file -`, {
      input: texte,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    journal('Ticket GitHub impossible :', e.message);
  }
}
