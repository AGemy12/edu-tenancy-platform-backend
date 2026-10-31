# API image for a VPS (see deploy/README.md). Debian rather than Alpine: sharp and Chromium
# (PDF reports) both ship for glibc.

# ── build ──
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# prisma.config.ts reads DATABASE_URL; generating the client never connects, so any URL will do.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate && npm run build

# ── run ──
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=/app/storage \
    PDF_CHROME_PATH=/usr/bin/chromium
# Dev dependencies stay: `prisma migrate deploy` runs at start.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000
CMD ["npm", "run", "start:migrate"]
