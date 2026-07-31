FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack
ENV PNPM_HOME=/tmp/pnpm-home
ENV PNPM_STORE_DIR=/tmp/pnpm-store
ENV PATH=$PNPM_HOME:$PATH
ENV DANO_DEFAULT_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/
ARG NPM_REGISTRY=
ARG NPM_CONFIG_REGISTRY=
RUN registry="${NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-$DANO_DEFAULT_NPM_REGISTRY}}" \
  && npm config set registry "$registry" \
  && npm_config_registry="$registry" corepack enable \
  && npm_config_registry="$registry" corepack prepare pnpm@9.15.9 --activate \
  && pnpm config set registry "$registry"

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/dano/package.json apps/dano/package.json
COPY apps/sites/package.json apps/sites/package.json
RUN registry="${NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-$DANO_DEFAULT_NPM_REGISTRY}}" \
  && npm_config_registry="$registry" \
  npm_config_fetch_timeout=600000 \
  pnpm install --frozen-lockfile --filter ./apps/sites... \
    --store-dir="$PNPM_STORE_DIR" --package-import-method=copy

COPY apps/sites apps/sites

ARG DANO_SITE_BASE_PATH=/web
ENV DANO_SITE_BASE_PATH=$DANO_SITE_BASE_PATH
RUN pnpm -C apps/sites build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app/apps/sites
ENV NODE_ENV=production
ENV DANO_SITE_BASE_PATH=/web

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/sites/package.json ./package.json
COPY --from=build /app/apps/sites/node_modules ./node_modules
COPY --from=build /app/apps/sites/dist ./dist
COPY --from=build /app/apps/sites/public ./public
COPY --from=build /app/apps/sites/next.config.ts /app/apps/sites/vite.config.ts ./
COPY --from=build /app/apps/sites/build ./build
COPY --from=build /app/apps/sites/worker ./worker

ARG DANO_SITE_REVISION=unknown
ARG DANO_SITE_VERSION=unknown
LABEL org.opencontainers.image.revision=$DANO_SITE_REVISION
LABEL org.opencontainers.image.version=$DANO_SITE_VERSION
LABEL dano.site.base-path=/web/

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/web/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "node_modules/vinext/dist/cli.js", "start", "--host", "0.0.0.0", "--port", "8080"]
