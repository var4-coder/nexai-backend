import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

const execFileAsync = promisify(execFile);

/**
 * Build + déploie un projet Next.js déjà scaffoldé (voir nextjs-pipeline.service.ts)
 * en s'appuyant sur netlify-cli — c'est ce que fait Netlify en interne pour tout
 * déploiement Next.js (le CLI exécute le build en local, applique le plugin officiel
 * @netlify/plugin-nextjs qui transforme les pages/API routes en Netlify
 * Functions/Edge Functions, puis pousse le résultat), donc on obtient exactement le
 * même comportement qu'un déploiement Netlify "classique" mais déclenché depuis
 * notre worker au lieu d'un `git push`.
 *
 * Nécessite NETLIFY_ACCESS_TOKEN (déjà utilisé par netlify.service.ts) et un accès
 * réseau sortant vers npm + Netlify depuis le worker.
 */
export async function buildAndDeployNextjsSite(params: {
  projectDir: string;
  netlifySiteId: string;
}): Promise<{ url: string }> {
  if (!env.NETLIFY_ACCESS_TOKEN) {
    throw new AppError('Netlify non configuré', 503);
  }

  const spawnOpts = {
    cwd: params.projectDir,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 1024 * 1024 * 20,
    timeout: 10 * 60 * 1000, // 10 min — build Next.js + upload
  };

  // 1. Installation des dépendances du projet généré (next/react uniquement).
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], spawnOpts);

  // 2. Build + déploiement en une commande. `--build` fait tourner `npm run build`
  //    (avec le plugin Next.js déclaré dans netlify.toml) avant d'uploader.
  const { stdout } = await execFileAsync(
    'npx',
    [
      '--yes',
      'netlify-cli',
      'deploy',
      '--build',
      '--prod',
      `--site=${params.netlifySiteId}`,
      `--auth=${env.NETLIFY_ACCESS_TOKEN}`,
    ],
    spawnOpts
  );

  const match = stdout.match(/https:\/\/[^\s]+\.netlify\.app/) || stdout.match(/Website URL:\s*(\S+)/);
  const url = Array.isArray(match) ? (match[1] || match[0]) : '';

  if (!url) {
    throw new AppError('Déploiement Next.js terminé mais URL introuvable dans la sortie netlify-cli', 502);
  }

  return { url };
}
