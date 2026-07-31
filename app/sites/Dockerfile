FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG DANO_SITE_BASE_PATH=/web
ENV DANO_SITE_BASE_PATH=$DANO_SITE_BASE_PATH
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV DANO_SITE_BASE_PATH=/web

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts /app/vite.config.ts ./
COPY --from=build /app/build ./build
COPY --from=build /app/worker ./worker

ARG DANO_SITE_REVISION=unknown
ARG DANO_SITE_VERSION=unknown
LABEL org.opencontainers.image.revision=$DANO_SITE_REVISION
LABEL org.opencontainers.image.version=$DANO_SITE_VERSION
LABEL dano.site.base-path=/web/

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/web/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start", "--", "--host", "0.0.0.0", "--port", "8080"]
