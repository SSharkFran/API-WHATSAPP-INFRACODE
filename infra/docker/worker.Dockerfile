FROM node:20-bookworm-slim AS base

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/types/package.json packages/types/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm prisma:generate \
  && pnpm --filter @infracode/worker build

CMD ["node", "apps/worker/dist/index.js"]
