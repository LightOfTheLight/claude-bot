# ── Stage 1: dependencies (with native build tools for better-sqlite3) ────────
FROM node:20-alpine AS deps

WORKDIR /app

# Build tools required for better-sqlite3 native compilation on Alpine (musl libc)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

# Data directory — mounted as a volume in docker-compose; pre-create so
# permissions are correct when the volume is first attached
RUN mkdir -p /app/data && chown botuser:botgroup /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/

RUN chown -R botuser:botgroup /app

USER botuser

ENV NODE_ENV=production

EXPOSE 3000 9464

CMD ["node", "src/index.js"]
