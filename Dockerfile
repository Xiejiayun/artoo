# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/build-preview.mjs ./scripts/build-preview.mjs
RUN npm ci && npm run build:preview

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/storage/package.json ./packages/storage/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @artoo/server && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production \
    ARTOO_HOST=0.0.0.0 \
    ARTOO_PORT=4000 \
    ARTOO_WEB_DIST=/app/apps/web/dist \
    ARTOO_REQUIRE_REMOTE_STORAGE=1 \
    ARTOO_BLOB_BACKEND=supabase
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/storage/dist ./packages/storage/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
