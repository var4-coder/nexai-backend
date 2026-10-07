import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

export interface NextjsPageInput {
  slug: string; // 'index' | 'biens' | 'contact' ...
  title: string;
  html: string;
}

/**
 * Génère les fichiers d'un projet Next.js pour les sites marqués
 * `siteType: 'nextjs'` (voir models/Site.ts) : hôtellerie, immobilier, mode.
 *
 * CORRECTIF du 02/10/2026 — avant, chaque page HTML était collée dans un
 * bloc React (dangerouslySetInnerHTML). Conséquences : ses scripts ne
 * s'exécutaient JAMAIS (formulaire de réservation vide, menu mobile inerte,
 * animation absente) et les réglages posés sur <html> (famille, densité,
 * geste) étaient perdus. Désormais, les pages préparées pour la mise en
 * ligne (publication.service) sont servies TELLES QUELLES, comme fichiers
 * statiques du dossier public/, avec des réécritures d'adresses (/ → index,
 * /menu → menu.html…). Les formulaires sont envoyés au backend NexAI comme
 * sur un site statique ; la route serveur propre au site (/api/submit) reste
 * disponible pour la logique serveur à venir.
 */
export async function scaffoldNextjsProject(params: {
  targetDir: string;
  siteId: string;
  siteName: string;
  /** Fichiers du site déjà préparés (voir fichiersStatiques) : pages, pages légales, kit. */
  fichiers: { path: string; content: string | Buffer }[];
  publicApiKey: string;
  publicApiBaseUrl: string;
}): Promise<void> {
  const { targetDir, siteId, siteName, fichiers, publicApiKey, publicApiBaseUrl } = params;

  await mkdir(path.join(targetDir, 'pages', 'api'), { recursive: true });
  await mkdir(path.join(targetDir, 'public'), { recursive: true });

  await writeFile(
    path.join(targetDir, 'package.json'),
    JSON.stringify(
      {
        name: `nexai-site-${siteId}`,
        version: '1.0.0',
        private: true,
        scripts: { build: 'next build', start: 'next start', dev: 'next dev' },
        dependencies: {
          next: '^14.2.5',
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
      },
      null,
      2
    )
  );

  // Le plugin officiel @netlify/plugin-nextjs gère le build SSR/API routes sur Netlify.
  await writeFile(
    path.join(targetDir, 'netlify.toml'),
    `[build]\n  command = "npm run build"\n\n[[plugins]]\n  package = "@netlify/plugin-nextjs"\n`
  );

  // Pages du site = fichiers statiques de public/ (servis tels quels).
  const slugs = new Set<string>();
  for (const f of fichiers) {
    const cible = path.join(targetDir, 'public', f.path);
    await mkdir(path.dirname(cible), { recursive: true });
    await writeFile(cible, f.content);
    const m = /^([a-z0-9_-]+)\.html$/i.exec(f.path);
    if (m && m[1] !== 'index') slugs.add(m[1]);
  }
  const reecritures = [
    { source: '/', destination: '/index.html' },
    ...[...slugs].map((s) => ({ source: `/${s}`, destination: `/${s}.html` })),
  ];
  await writeFile(
    path.join(targetDir, 'next.config.js'),
    `module.exports = {\n  reactStrictMode: true,\n  async rewrites() {\n    return { beforeFiles: ${JSON.stringify(reecritures)} };\n  },\n};\n`
  );

  // La clé publique du site n'est pas un secret critique (voir Site.publicApiKey) :
  // on peut l'exposer côté client sans risque, comme une clé publique Stripe.
  await writeFile(
    path.join(targetDir, '.env.production'),
    `NEXT_PUBLIC_NEXAI_SITE_ID=${siteId}\nNEXT_PUBLIC_NEXAI_SITE_KEY=${publicApiKey}\nNEXT_PUBLIC_NEXAI_API_BASE=${publicApiBaseUrl}\n`
  );

  await writeFile(
    // JavaScript simple (pas de TypeScript) : le build n'a besoin que de next et react.
    path.join(targetDir, 'pages', '_app.js'),
    `export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`
  );

  // Route API serveur du site — c'est LE vrai backend applicatif propre au
  // site (exécuté par Netlify Functions via le plugin Next.js), commune à
  // toutes les pages, qui relaie ensuite vers le stockage central NexAI
  // (MongoDB). On peut y ajouter plus tard de la logique métier propre au
  // site (validation avancée, calculs, intégrations tierces...) sans toucher
  // au backend central.
  await writeFile(
    path.join(targetDir, 'pages', 'api', 'submit.js'),
      `const NEXAI_API_BASE = process.env.NEXT_PUBLIC_NEXAI_API_BASE;\n` +
      `const NEXAI_SITE_ID = process.env.NEXT_PUBLIC_NEXAI_SITE_ID;\n` +
      `const NEXAI_SITE_KEY = process.env.NEXT_PUBLIC_NEXAI_SITE_KEY;\n\n` +
      `export default async function handler(req, res) {\n` +
      `  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });\n` +
      `  try {\n` +
      `    const upstream = await fetch(\`\${NEXAI_API_BASE}/api/v1/public/sites/\${NEXAI_SITE_ID}/submit\`, {\n` +
      `      method: 'POST',\n` +
      `      headers: { 'Content-Type': 'application/json', 'x-nexai-site-key': NEXAI_SITE_KEY || '' },\n` +
      `      body: JSON.stringify(req.body),\n` +
      `    });\n` +
      `    const json = await upstream.json();\n` +
      `    return res.status(upstream.status).json(json);\n` +
      `  } catch (err) {\n` +
      `    return res.status(502).json({ error: 'nexai_upstream_unreachable' });\n` +
      `  }\n` +
      `}\n`
  );



  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${siteName}\n\nProjet Next.js généré par NexAI (site ${siteId}).\nPages (public/) : ${['index', ...slugs].join(', ')}\n`
  );
}
