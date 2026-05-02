# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder
WORKDIR /build
ENV CI=1

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared/package.json shared/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

RUN npm run build
RUN npm prune --omit=dev --workspaces --include-workspace-root


FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /build/package.json /build/package-lock.json* ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/server ./server
COPY --from=builder /build/shared ./shared
COPY --from=builder /build/web/dist ./web/dist

RUN mkdir -p /data && chown -R app:app /data /app
USER app

ENV PORT=3000 \
    DATABASE_PATH=/data/albums.sqlite

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/src/server.js"]
