FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY . .

ARG APP_REVISION=unknown
RUN APP_REVISION="$APP_REVISION" pnpm run build

EXPOSE 3000

CMD ["node", "apps/api/dist/server.js"]
