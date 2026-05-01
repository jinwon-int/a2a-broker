FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ARG A2A_BROKER_VERSION=0.1.0
ARG A2A_BROKER_REVISION=unknown
ARG A2A_BROKER_CREATED
ARG A2A_BROKER_IMAGE_SOURCE=https://github.com/jinwon-int/a2a-broker
LABEL org.opencontainers.image.source=$A2A_BROKER_IMAGE_SOURCE \
      org.opencontainers.image.version=$A2A_BROKER_VERSION \
      org.opencontainers.image.revision=$A2A_BROKER_REVISION \
      org.opencontainers.image.created=$A2A_BROKER_CREATED
WORKDIR /app
ENV NODE_ENV=production \
    A2A_BROKER_VERSION=$A2A_BROKER_VERSION \
    A2A_BROKER_REVISION=$A2A_BROKER_REVISION \
    A2A_BROKER_BUILT_AT=$A2A_BROKER_CREATED \
    A2A_BROKER_SOURCE=github.com/jinwon-int/a2a-broker \
    A2A_BROKER_RUNTIME=docker
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
COPY scripts/export-sqlite-state.mjs ./scripts/export-sqlite-state.mjs
COPY scripts/openclaw-a2a-task-handler.mjs ./scripts/openclaw-a2a-task-handler.mjs
RUN mkdir -p ./handlers && cp scripts/openclaw-a2a-task-handler.mjs ./handlers/openclaw-a2a-task-handler.mjs
EXPOSE 8787
CMD ["node", "dist/server.js"]
