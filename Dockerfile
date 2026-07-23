FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
COPY shared/package.json shared/package-lock.json* ./shared/
COPY contracts/package.json contracts/package-lock.json* ./contracts/
COPY services/api/package.json services/api/package-lock.json* ./services/api/
RUN npm ci

COPY shared ./shared
COPY contracts ./contracts
COPY services/api ./services/api
COPY tsconfig.base.json ./tsconfig.base.json
RUN npm run build -w @pact/shared
RUN npm run build -w @pact/api
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/contracts/package.json ./contracts/package.json
COPY --from=build /app/services/api/package.json ./services/api/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/services/api/dist ./services/api/dist

RUN mkdir -p /app/data
EXPOSE 4100
CMD ["npm", "run", "start", "-w", "@pact/api"]
