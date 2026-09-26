# NexAI Backend — complet

Backend Express + MongoDB + Redis/BullMQ (TypeScript).

## Corrections incluses
- Vidéo IA : site-meta, video-pipeline (Claude Sonnet pour prompts), video-ads routes
- Vidéo IA (mixte) : logo auto (extrait du site > IA en fallback), voix off variée (pool de voix ElevenLabs), CTA/watermark incrusté, capture réelle du site (Playwright) en plan "démonstration"
- Logos : quotas Agence/Pro Max, prompts Claude → Recraft
- Paiements utilisateur : PATCH /users/me/payments, defaultPaymentMode, personalPaymentLink, compteReversement (Mobile Money / crypto)
- User model étendu (logosUsed, payment fields)

## Académie (version 3 — 25/09/2026)
- Structure Domaine (22) → Formation (60) → Leçons ; programme et textes de base dans `src/data/academy-modules.ts`, créés en base au démarrage (`assurerCatalogue`), jamais écrasés ensuite
- Parties : bases (Partie 1), complet / pratique / kit (Partie 2 : Comprendre, Pratiquer, Outils)
- Accès (option C) : essai 7 jours = vidéos IA bases + complet ; pratique et kit PDF verrouillés ; après l'essai tout est visible mais verrouillé ; Starter = tout (`academy-programme.service.ts`)
- Rien de vide n'est envoyé au client ; chiffres publics réels via `GET /academy/stats`
- Générateur « PDF → vidéo IA » (`academy-video-generator.service.ts`, file BullMQ `academy-video`) : script d'explication par Claude, relecture admin, diapositives Chromium, voix Gemini (ou ElevenLabs), montage ffmpeg, envoi Bunny
- Kit PDF téléchargeable avec filigrane (`GET /academy/:id/telecharger`), abonnés uniquement
- Catalogue PeerTube (vraies vidéos pratiques CC) noté par Claude, import direct sur Bunny ; YouTube retiré de l'Académie
- Textes Sonnet et images Pexels des domaines et formations régénérables depuis l'admin

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
