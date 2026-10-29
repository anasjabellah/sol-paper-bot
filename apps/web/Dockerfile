# Build from the repository root:  docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:4000
ARG NEXT_PUBLIC_API_TOKEN=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_API_TOKEN=$NEXT_PUBLIC_API_TOKEN \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @spb/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/web
USER node
EXPOSE 3000
# Inside the container listen on all interfaces; compose publishes on 127.0.0.1 only.
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
