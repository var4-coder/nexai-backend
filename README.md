# NexAI Backend — complet

Backend Express + MongoDB + Redis/BullMQ (TypeScript).

## Corrections incluses
- Vidéo IA : site-meta, video-pipeline (Claude Sonnet pour prompts), video-ads routes
- Vidéo IA (mixte) : logo auto (extrait du site > IA en fallback), voix off variée (pool de voix ElevenLabs), CTA/watermark incrusté, capture réelle du site (Playwright) en plan "démonstration"
- Logos : quotas Agence/Pro Max, prompts Claude → Recraft
- Paiements utilisateur : PATCH /users/me/payments, defaultPaymentMode, personalPaymentLink, compteReversement (Mobile Money / crypto)
- User model étendu (logosUsed, payment fields)

## Playwright (capture réelle du site)
`npm install` déclenche automatiquement `playwright install --with-deps chromium`
(script `postinstall`) pour télécharger le binaire Chromium nécessaire à
`site-capture.service.ts`. Sur un hébergeur type Render, ça tourne au build —
vérifiez juste que l'environnement de build autorise le téléchargement
(playwright.azureedge.net / playwright-download endpoints) et dispose d'assez
d'espace disque (~300 Mo pour Chromium headless).

## Lancer
```bash
cd nexai-backend
npm install
# configurer .env (Mongo, Redis, JWT, clés API…)
npm run dev
# worker jobs :
npm run worker
```

## Structure
src/app.ts, server.ts, config/, models/, routes/, services/, jobs/, middleware/
