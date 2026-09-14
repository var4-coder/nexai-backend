# NexAI Backend — Déploiement Render

## ⚠️ DEUX services Render obligatoires

Le serveur HTTP **ne lance pas** le worker. Sans le second service, les sites
et vidéos resteraient en file d'attente indéfiniment.

| Service | Type | Commande de démarrage |
|---|---|---|
| `nexai-api` | Web Service | `npm start` |
| `nexai-worker` | Background Worker | `npm run worker` |

Les deux partagent le **même dépôt, la même build (`npm run build`) et les
mêmes variables d'environnement**.

## Dépendances système (image Render)

- **ffmpeg** — obligatoire, sinon toute génération vidéo échoue (le client
  est remboursé automatiquement, mais la fonctionnalité est inutilisable).
- Police **DejaVu** — incrustation de texte dans les vidéos.
- Chromium (Playwright) — installé par le `postinstall`, ~300 Mo au build.

Si l'image Render ne fournit pas ffmpeg, ajouter un `Dockerfile` :
```
FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
```

## Variables d'environnement

Voir `.env.example` (34 variables). **Trois sont bloquantes au démarrage** :
`MONGODB_URI`, `REDIS_URL`, `JWT_SECRET`.

Points d'attention :
- `CLIENT_URL` : URL Netlify exacte, en https, **sans slash final**.
- `NODE_ENV=production` : sinon un webhook Chariow sans secret est accepté.
- `ADMIN_EMAIL` : détermine le compte administrateur.

## Après le premier déploiement

1. **Vérifier l'auto-seed de la Librairie** dans les logs :
   `📚 Librairie NexAI — auto-seed initial : 13 collection(s) créée(s)`
   Si le message n'apparaît pas, lancer `npm run seed:library`.

2. **Compte admin existant** : si le compte a été créé avant le correctif de
   plan, lancer une fois `npm run fix:admin` (il serait sinon bloqué en
   plan `trial` : pas de mise en ligne, pas de logo, pas d'Espace Agence).

## Parcours à tester en priorité

1. Inscription → vérifie Mongo + les 15 crédits d'essai
2. Génération d'un site en essai → vérifie la Librairie, les scans, les juges
3. Paiement test → vérifie le webhook, l'idempotence et le parrainage
4. Génération vidéo → vérifie ffmpeg et les files BullMQ
