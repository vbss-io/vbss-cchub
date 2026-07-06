# syntax=docker/dockerfile:1
FROM node:20-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/landing/package.json apps/landing/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
COPY apps/desktop/package.json apps/desktop/
COPY apps/vscode-ext/package.json apps/vscode-ext/
RUN npm ci -w @cch/landing
COPY apps/landing apps/landing
RUN npm run build -w @cch/landing

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /repo/apps/landing/dist /usr/share/nginx/html
EXPOSE 8080
