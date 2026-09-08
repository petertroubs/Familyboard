# ── Étape de compilation ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 utilise un binaire précompilé quand il existe ; ces outils
# servent de repli si la plateforme impose une compilation locale.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Dépendances de production uniquement, pour l'image finale.
RUN npm prune --omit=dev

# ── Image d'exécution ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# La base SQLite vit dans un volume : elle survit aux mises à jour de l'image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
ENV DATABASE_PATH=/data/familyboard.db
ENV PORT=3000
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
