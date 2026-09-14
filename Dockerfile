# Image officielle Playwright : contient déjà Chromium + toutes ses libs système
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# ffmpeg n'est pas inclus dans l'image Playwright : on l'installe manuellement
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Copie et installe les dépendances Node
COPY package.json package-lock.json ./
RUN npm ci

# Copie le reste du code
COPY . .

# Compile le TypeScript (build défini dans package.json)
RUN npm run build

# Render fournit la variable PORT automatiquement, ton app doit l'utiliser
EXPOSE 3000

CMD ["npm", "start"]
