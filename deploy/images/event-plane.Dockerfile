FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node esbuild.mjs platform/eventPlane.ts dist/event-plane.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/event-plane.mjs ./dist/event-plane.mjs
USER node
ENV NODE_ENV=production MESHR_HOST=0.0.0.0 MESHR_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "dist/event-plane.mjs"]
