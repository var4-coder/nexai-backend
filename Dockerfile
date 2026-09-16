# ══════════════════════════════════════════════════════════════════
# NexAI Backend — image de production
#
# Pourquoi Docker plutôt que l'environnement Node natif de Render :
#   · ffmpeg est INDISPENSABLE — sans lui, aucune vidéo ne se génère
#     (le client est remboursé automatiquement, mais la fonction est morte).
#   · Chromium permet la capture réelle du site du client, la scène qui
#     prouve que son site existe vraiment.
#   · Les polices DejaVu servent à l'incrustation de texte dans les vidéos.
# Aucun de ces trois éléments n'est installable sans droits root, que
# l'environnement natif de Render n'accorde pas.
#
# Cette même image sert aux DEUX services (web et worker) : ils partagent
# le code, seule la commande de démarrage change.
# ══════════════════════════════════════════════════════════════════

FROM node:22-bookworm-slim

# ── Dépendances système ───────────────────────────────────────────
# ffmpeg        : montage audio/vidéo (obligatoire)
# fonts-dejavu  : incrustation de texte dans les vidéos
# ca-certificates : appels HTTPS vers les API (Anthropic, Cloudinary…)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      ca-certificates \
      wget \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dépendances Node ──────────────────────────────────────────────
# Copiées seules d'abord : Docker réutilise alors ce cache tant que les
# dépendances ne changent pas, ce qui accélère nettement les déploiements.
COPY package*.json ./

# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD empêche le postinstall de télécharger
# Chromium ici : on l'installe juste après avec ses bibliothèques système,
# ce qui n'est possible qu'en root (donc impossible hors Docker).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# Chromium + toutes ses dépendances système. C'est précisément l'étape qui
# échouait sur Render en natif (« su: Authentication failure ») : ici nous
# sommes root, elle réussit.
RUN npx playwright install --with-deps chromium

# ── Code applicatif et compilation ────────────────────────────────
COPY . .
RUN npm run build

# Les devDependencies ne servent plus après la compilation : les retirer
# allège l'image et réduit la surface exposée.
RUN npm prune --omit=dev

# ── Exécution ─────────────────────────────────────────────────────
ENV NODE_ENV=production
# Render fournit le port via la variable PORT ; 3001 n'est qu'un repli local.
ENV PORT=3001
EXPOSE 3001

# Commande par défaut = service web.
# Le service worker surcharge cette commande par : node dist/jobs/worker.js
CMD ["node", "dist/server.js"]
