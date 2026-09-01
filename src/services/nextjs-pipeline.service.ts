import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

export interface NextjsPageInput {
  slug: string; // 'index' | 'biens' | 'contact' ...
  title: string;
  html: string;
}

/**
 * Génère les fichiers d'un projet Next.js pour les sites marqués
 * `siteType: 'nextjs'` (voir models/Site.ts). Utilisé pour les sites
 * "complexes" qui ont besoin d'un vrai backend applicatif (route API propre
 * au site) en plus du stockage central NexAI (MongoDB, via /api/v1/public).
 *
 * Multi-pages : une route Next.js par page du plan généré par le pipeline IA
 * (voir resolvePagePlan / PAGES_PAR_NICHE dans ia-pipeline.service.ts) — pour
 * un site à page unique, `pages` ne contient que l'entrée 'index'.
 *
 * Le rendu visuel généré par le pipeline IA (HTML par page) est réinjecté
 * tel quel dans chaque route Next.js correspondante, pour ne pas dupliquer
 * la logique de génération de design — seule la couche technique change
 * (React/Next au lieu de HTML statique), avec en plus une vraie route API
 * serveur fonctionnelle.
 */
/**
 * Les pages générées par le pipeline IA se lient entre elles via des hrefs
 * de type "biens.html", "contact.html" (format adapté au déploiement HTML
 * statique, voir buildSecondaryPageSystemPrompt côté ia-pipeline.service.ts).
 * En Next.js le routing se fait par chemin ("/biens", "/") et non par nom de
 * fichier : sans cette réécriture, la navigation entre pages casserait au
 * clic (Netlify chercherait un fichier biens.html inexistant dans un site
 * Next.js). On ne touche à rien d'autre dans le HTML.
 */
function rewriteLinksForNextjs(html: string): string {
  return html
    .replace(/href=(["'])(?:\.\/)?index\.html\1/gi, 'href=$1/$1')
    .replace(/href=(["'])(?:\.\/)?([a-z0-9_-]+)\.html\1/gi, 'href=$1/$2$1');
}

export async function scaffoldNextjsProject(params: {
  targetDir: string;
  siteId: string;
  siteName: string;
  pages: NextjsPageInput[];
  publicApiKey: string;
  publicApiBaseUrl: string;
}): Promise<void> {
  const { targetDir, siteId, siteName, pages, publicApiKey, publicApiBaseUrl } = params;

  await mkdir(path.join(targetDir, 'pages', 'api'), { recursive: true });

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

  await writeFile(path.join(targetDir, 'next.config.js'), `module.exports = { reactStrictMode: true };\n`);

  // La clé publique du site n'est pas un secret critique (voir Site.publicApiKey) :
  // on peut l'exposer côté client sans risque, comme une clé publique Stripe.
  await writeFile(
    path.join(targetDir, '.env.production'),
    `NEXT_PUBLIC_NEXAI_SITE_ID=${siteId}\nNEXT_PUBLIC_NEXAI_SITE_KEY=${publicApiKey}\nNEXT_PUBLIC_NEXAI_API_BASE=${publicApiBaseUrl}\n`
  );

  await writeFile(
    path.join(targetDir, 'pages', '_app.tsx'),
    `import type { AppProps } from 'next/app';\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />;\n}\n`
  );

  // Câblage des formulaires (data-nexai-id="form-contact", ou
  // data-nexai-type="reservation"/"commande") vers /api/submit, factorisé
  // pour être réutilisé identiquement sur chaque page générée ci-dessous.
  const wiringHook =
    `  const rootRef = useRef<HTMLDivElement>(null);\n` +
    `  useEffect(() => {\n` +
    `    const root = rootRef.current;\n` +
    `    if (!root) return;\n` +
    `    function toObject(form: HTMLFormElement) {\n` +
    `      const data: Record<string, string> = {};\n` +
    `      new FormData(form).forEach((v, k) => { data[k] = String(v); });\n` +
    `      return data;\n` +
    `    }\n` +
    `    function wire(form: HTMLFormElement, type: string) {\n` +
    `      form.addEventListener('submit', async (evt) => {\n` +
    `        evt.preventDefault();\n` +
    `        const honeypot = form.querySelector('input[name="website"], input[name="_honeypot"]') as HTMLInputElement | null;\n` +
    `        if (honeypot && honeypot.value) return;\n` +
    `        try {\n` +
    `          const res = await fetch('/api/submit', {\n` +
    `            method: 'POST',\n` +
    `            headers: { 'Content-Type': 'application/json' },\n` +
    `            body: JSON.stringify({ type, data: toObject(form) }),\n` +
    `          });\n` +
    `          if (!res.ok) throw new Error('submit_failed');\n` +
    `          form.reset();\n` +
    `        } catch {\n` +
    `          /* feedback visuel géré par le composant généré (aria-live) */\n` +
    `        }\n` +
    `      });\n` +
    `    }\n` +
    `    root.querySelectorAll('[data-nexai-id="form-contact"], form[data-nexai-type="contact"]').forEach((f) => wire(f as HTMLFormElement, 'contact'));\n` +
    `    root.querySelectorAll('form[data-nexai-type="reservation"]').forEach((f) => wire(f as HTMLFormElement, 'reservation'));\n` +
    `    root.querySelectorAll('form[data-nexai-type="commande"]').forEach((f) => wire(f as HTMLFormElement, 'commande'));\n` +
    `  }, []);\n`;

  for (const page of pages) {
    const fileName = page.slug === 'index' ? 'index.tsx' : `${page.slug}.tsx`;
    const safeHtml = JSON.stringify(rewriteLinksForNextjs(page.html));
    await writeFile(
      path.join(targetDir, 'pages', fileName),
      `import { useEffect, useRef } from 'react';\n\n` +
        `// Page "${page.title}" générée par le pipeline IA NexAI, injectée telle quelle\n` +
        `// (voir services/ia-pipeline.service.ts côté backend). Le contrat\n` +
        `// data-nexai-id des composants reste identique à la version statique.\n` +
        `const NEXAI_HTML = ${safeHtml};\n\n` +
        `export default function Page() {\n${wiringHook}` +
        `  return <div ref={rootRef} dangerouslySetInnerHTML={{ __html: NEXAI_HTML }} />;\n` +
        `}\n`
    );
  }

  // Route API serveur du site — c'est LE vrai backend applicatif propre au
  // site (exécuté par Netlify Functions via le plugin Next.js), commune à
  // toutes les pages, qui relaie ensuite vers le stockage central NexAI
  // (MongoDB). On peut y ajouter plus tard de la logique métier propre au
  // site (validation avancée, calculs, intégrations tierces...) sans toucher
  // au backend central.
  await writeFile(
    path.join(targetDir, 'pages', 'api', 'submit.ts'),
    `import type { NextApiRequest, NextApiResponse } from 'next';\n\n` +
      `const NEXAI_API_BASE = process.env.NEXT_PUBLIC_NEXAI_API_BASE;\n` +
      `const NEXAI_SITE_ID = process.env.NEXT_PUBLIC_NEXAI_SITE_ID;\n` +
      `const NEXAI_SITE_KEY = process.env.NEXT_PUBLIC_NEXAI_SITE_KEY;\n\n` +
      `export default async function handler(req: NextApiRequest, res: NextApiResponse) {\n` +
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
    path.join(targetDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          lib: ['dom', 'ES2020'],
          jsx: 'preserve',
          module: 'esnext',
          moduleResolution: 'node',
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          isolatedModules: true,
          incremental: true,
        },
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules'],
      },
      null,
      2
    )
  );

  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${siteName}\n\nProjet Next.js généré par NexAI (site ${siteId}).\nPages : ${pages.map((p) => p.slug).join(', ')}\n`
  );
}
