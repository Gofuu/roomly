# API image. The web app is static (apps/web/dist) and is served from S3/CloudFront.
#   docker build -t roomly-api .
#   docker run --env-file .env -p 4000:4000 roomly-api                          # API
#   docker run --env-file .env roomly-api node apps/api/dist/migrate.js         # migrations (once per deploy)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build -w @roomly/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/db/migrations
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# Runtime dependencies of the API only (the bundle already contains the workspace TypeScript).
RUN npm ci --omit=dev --workspace=@roomly/api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db/migrations db/migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
