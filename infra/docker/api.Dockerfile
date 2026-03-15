FROM node:20-bookworm-slim AS base

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/panel/package.json apps/panel/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/sdk-js/package.json packages/sdk-js/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm prisma:generate \
  && pnpm --filter @infracode/types build \
  && pnpm --filter @infracode/api build

EXPOSE 3333

CMD ["node", "apps/api/dist/apps/api/src/server.js"]
