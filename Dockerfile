# One image for the whole app: the API, which also serves the built web app.
#   docker build -t roomly .
#   docker run --env-file .env -p 4000:4000 roomly

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
# Shows the "demo accounts" buttons on the login page. On for the public demo.
ARG VITE_SHOW_DEMO_ACCOUNTS=false
ENV VITE_SHOW_DEMO_ACCOUNTS=$VITE_SHOW_DEMO_ACCOUNTS
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/db/migrations \
    WEB_DIST_DIR=/app/web
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# Only what the API needs at run time. The build output already contains our own code.
RUN npm ci --omit=dev --workspace=@roomly/api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist web
COPY db/migrations db/migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
