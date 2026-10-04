FROM node:22-alpine AS builder
RUN apk add --no-cache openssl ca-certificates
WORKDIR /app

# Dependency layer — cache-friendly: only rerun when package*.json changes
COPY package*.json ./
COPY patches ./patches/
COPY prisma ./prisma/
RUN npm ci --legacy-peer-deps && npm cache clean --force

# Source & build
COPY . .
RUN npx prisma generate && npm run build

# Strip devDeps from node_modules after build (tsx/typescript are runtime deps for the custom server)
RUN npm prune --omit=dev && npm cache clean --force

# Production image
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl ca-certificates
WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["sh", "-c", "set -eu; npx prisma db push; if [ -n \"${ADMIN_EMAIL:-}\" ] && [ -n \"${ADMIN_PASSWORD:-}\" ]; then node scripts/setup-admin.cjs \"$ADMIN_EMAIL\" \"$ADMIN_PASSWORD\"; fi; exec node node_modules/tsx/dist/cli.mjs src/server/index.ts"]
