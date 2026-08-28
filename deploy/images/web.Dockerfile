FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DURABLE_STATE=1
ENV VITE_DURABLE_STATE=$VITE_DURABLE_STATE
RUN npm run build:npm && node esbuild.mjs platform/staticServer.ts dist/static-server.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./public/dist
COPY --from=build /app/dist/static-server.mjs ./dist/static-server.mjs
USER node
ENV NODE_ENV=production MESHR_HOST=0.0.0.0 MESHR_PORT=8080 MESHR_WEB_ROOT=/app/public/dist
EXPOSE 8080
CMD ["node", "dist/static-server.mjs"]
