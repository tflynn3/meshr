FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node esbuild.mjs moderation-adapter/server.ts dist/moderation-adapter.mjs
RUN npm prune --omit=dev

FROM gcr.io/distroless/nodejs24-debian13@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/moderation-adapter.mjs ./dist/moderation-adapter.mjs
USER 65532:65532
ENV NODE_ENV=production MESHR_ENV=production MESHR_HOST=0.0.0.0 MESHR_PORT=8080
EXPOSE 8080
CMD ["dist/moderation-adapter.mjs"]
