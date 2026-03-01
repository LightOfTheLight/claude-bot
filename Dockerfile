# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

# Copy pruned dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/

# Ownership
RUN chown -R botuser:botgroup /app

USER botuser

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/index.js"]
