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
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
COPY scripts/export-sqlite-state.mjs ./scripts/export-sqlite-state.mjs
COPY scripts/openclaw-a2a-task-handler.mjs ./scripts/openclaw-a2a-task-handler.mjs
RUN mkdir -p ./handlers && cp scripts/openclaw-a2a-task-handler.mjs ./handlers/openclaw-a2a-task-handler.mjs
EXPOSE 8787
CMD ["node", "dist/server.js"]
