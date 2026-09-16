# NexAI — Déploiement pas à pas

Backend sur **Render** (Docker), frontend sur **Netlify**.

---

## Avant de commencer

| Élément | Où l'obtenir | Obligatoire ? |
|---|---|---|
| Base MongoDB | MongoDB Atlas (offre gratuite suffisante) | Oui |
| Redis | Render Key Value, ou Upstash | Oui |
| Clé Anthropic | console.anthropic.com | Oui |
| Clé xAI (Grok) | console.x.ai | Oui |
| Cloudinary | cloudinary.com | Oui |
| Chariow | votre compte marchand | Oui (paiements) |
| Brevo | brevo.com | Oui (emails) |
| Netlify token | app.netlify.com → User settings → Applications | Oui (mise en ligne des sites) |
| GoDaddy, FalAI, ElevenLabs, Recraft, Alexya, Pexels | selon les fonctions utilisées | Recommandé |

Sans une clé optionnelle, la fonction concernée renvoie une erreur claire —
le reste de la plateforme continue de fonctionner.

---

## Étape 1 — Base de données

1. Sur **MongoDB Atlas**, créez un cluster gratuit (M0).
2. **Database Access** → créez un utilisateur avec mot de passe.
3. **Network Access** → ajoutez `0.0.0.0/0` (Render utilise des IP variables).
4. **Connect → Drivers** → copiez l'URI, et ajoutez `/nexai` à la fin :
   `mongodb+srv://utilisateur:motdepasse@cluster.xxxxx.mongodb.net/nexai`

---

## Étape 2 — Redis

Sur Render : **New → Key Value** → nom `nexai-redis`, même région que votre API.
Copiez l'**Internal Redis URL**.

---

## Étape 3 — Code sur GitHub

Deux dépôts :
- `nexai-backend` → contenu de `backend-v10`
- `nexai-frontend` → contenu de `frontend-v9`

---

## Étape 4 — Service web (l'API)

Sur Render : **New → Web Service** → dépôt `nexai-backend`.

| Réglage | Valeur |
|---|---|
| Language / Runtime | **Docker** |
| Dockerfile Path | `./Dockerfile` |
| Docker Command | *(vide — la commande par défaut lance l'API)* |
| Instance Type | **Starter minimum** (le plan gratuit s'endort et coupe les générations) |

### Variables d'environnement

```
NODE_ENV=production
MONGODB_URI=mongodb+srv://…/nexai
REDIS_URL=redis://…
JWT_SECRET=…                   (chaîne aléatoire longue, 48 caractères)
CLIENT_URL=https://votre-site.netlify.app     (https, SANS slash final)
ADMIN_EMAIL=votre.email@exemple.com

ANTHROPIC_API_KEY=…
XAI_API_KEY=…
CLOUDINARY_CLOUD_NAME=…
CLOUDINARY_API_KEY=…
CLOUDINARY_API_SECRET=…
CHARIOW_API_KEY=…
CHARIOW_WEBHOOK_SECRET=…
BREVO_API_KEY=…
NETLIFY_ACCESS_TOKEN=…

# Optionnelles, selon les fonctions utilisées
GODADDY_API_KEY=…
GODADDY_API_SECRET=…
FALAI_API_KEY=…
ELEVENLABS_API_KEY=…
RECRAFT_API_KEY=…
ALEXYA_API_KEY=…
PEXELS_API_KEY=…

# Jeton de votre agent de maintenance externe (chaîne aléatoire longue).
# JAMAIS votre JWT : si ce jeton fuite, votre compte admin reste intact.
PLATFORM_AGENT_TOKEN=…
```

> **Le premier build prend 5 à 10 minutes** : Docker installe Chromium et
> ffmpeg. Les déploiements suivants sont bien plus rapides grâce au cache.

---

## Étape 5 — Le worker : deux options

### Option A — Plan free Render (recommandé pour démarrer) — mono-service

Render free **n’a pas de Background Worker**. Tout tourne dans **un seul**
Web Service : l’API + le worker BullMQ dans le même processus.

Par défaut le backend démarre déjà ainsi (`RUN_WORKER_IN_WEB=true`).  
Vous n’avez **rien à créer** de plus qu’un Web Service + Redis + Mongo.

Variables utiles sur le **Web Service** :

```
RUN_WORKER_IN_WEB=true
REDIS_URL=redis://…   # obligatoire (ex. Upstash free)
```

Dans les logs au démarrage vous devez voir :

```
⚙️  Mode mono-service : démarrage du worker dans ce processus
🔧 NexAI BullMQ worker démarré (queues: pipeline, reminders, quality-agent)
```

Limites du free à connaître :
- une génération vidéo lourde peut ralentir les requêtes HTTP le temps du job ;
- un redémarrage de l’API coupe les jobs en cours ;
- le Web Service free s’endort après ~15 min d’inactivité (une génération
  lancée juste avant peut être interrompue).

### Option B — Production (service Worker dédié, plus tard)

Quand vous payez un Background Worker :

1. Sur le **Web Service** : `RUN_WORKER_IN_WEB=false`
2. **New → Background Worker** → même dépôt `nexai-backend`

| Réglage | Valeur |
|---|---|
| Language / Runtime | **Docker** |
| Dockerfile Path | `./Dockerfile` |
| Docker Command | `node dist/jobs/worker.js` |

**Mêmes variables d’environnement que le service web** (Environment Group).

Sans worker (ni intégré ni dédié), les sites et vidéos resteraient en file
d’attente indéfiniment.

---

## Étape 6 — Frontend sur Netlify

1. **Add new site → Import an existing project** → dépôt `nexai-frontend`.
2. Build command : `npm run build` · Publish directory : `.next`
   Ajoutez le plugin **@netlify/plugin-nextjs** (Netlify le propose
   automatiquement pour un projet Next.js).
3. Variable d'environnement :

```
NEXT_PUBLIC_API_URL=https://nexai-api.onrender.com/api/v1
```

> Le suffixe **`/api/v1` est obligatoire** : c'est le préfixe réel des routes
> du backend. Sans lui, tous les appels échouent en 404.

4. Une fois l'URL Netlify connue, **retournez sur Render**, mettez `CLIENT_URL`
   à cette adresse exacte, et redéployez l'API.

---

## Étape 7 — Webhook Chariow

URL de notification à configurer chez Chariow :

```
https://nexai-api.onrender.com/api/v1/webhooks/chariow
```

Le secret doit correspondre exactement à `CHARIOW_WEBHOOK_SECRET`.
En production, un webhook non signé est systématiquement rejeté.

---

## Étape 8 — Vérifications

**1. L'API répond** — ouvrez `https://nexai-api.onrender.com/api/v1/health`.

**2. La librairie s'est chargée** — dans les logs du service web :
```
📚 Librairie NexAI — auto-seed initial : 13 collection(s) créée(s)
```
Sinon, lancez `npm run seed:library` depuis le shell Render.

**3. Le worker tourne** — dans ses logs :
```
🔧 NexAI BullMQ worker démarré (queues: pipeline, reminders, quality-agent)
```

**4. Votre compte admin** — inscrivez-vous avec l'adresse exacte d'`ADMIN_EMAIL`.
Vous devez voir **Administration** dans le menu et des crédits **illimités**.
Si le compte existait déjà, lancez une fois `npm run fix:admin`.

---

## Étape 9 — Tester le parcours complet

Dans cet ordre, chaque test validant une brique différente :

1. **Créer un compte** → MongoDB et les 15 crédits d'essai
2. **Générer un site** → librairie, scans, juges, worker
3. **Tester Vidéo IA** → ffmpeg, FalAI, files d'attente
4. **Payer un abonnement (test)** → webhook, idempotence, parrainage

---

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| Build échoue sur `playwright` | Le service n'est pas en mode **Docker** |
| Sites bloqués en « génération » | Le **service worker** est absent ou arrêté |
| Toutes les vidéos échouent | ffmpeg absent → l'image Docker n'est pas utilisée |
| 404 sur tous les appels | `NEXT_PUBLIC_API_URL` sans le suffixe `/api/v1` |
| Erreurs CORS | `CLIENT_URL` ne correspond pas exactement à l'URL Netlify, ou a un slash final |
| Webhook rejeté | `CHARIOW_WEBHOOK_SECRET` différent de celui configuré chez Chariow |
| Admin sans accès | Compte créé avant le correctif → `npm run fix:admin` |

---

## Coût mensuel indicatif

| Service | Offre | Prix |
|---|---|---|
| Web (API) | Starter | ~7 $ |
| Worker | Starter | ~7 $ |
| Redis | Starter | ~10 $ |
| MongoDB Atlas | M0 gratuit, puis M10 | 0 à 9 $ |
| Netlify | Gratuit au démarrage | 0 $ |

Environ **24 à 33 $/mois** pour démarrer.

> Évitez le plan gratuit Render pour l'API : le service s'endort après
> inactivité, ce qui interrompt les générations en cours.
