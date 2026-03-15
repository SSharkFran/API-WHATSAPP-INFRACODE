FROM node:20-bookworm-slim AS base

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/panel/package.json apps/panel/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @infracode/types build \
  && pnpm --filter @infracode/ui build \
  && pnpm --filter @infracode/panel build

EXPOSE 3000

CMD ["sh", "-lc", "pnpm --filter @infracode/panel start --hostname 0.0.0.0 --port ${PORT:-3000}"]
