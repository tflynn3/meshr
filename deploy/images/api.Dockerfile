FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node esbuild.mjs server/main.ts dist/server-main.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/server-main.mjs ./dist/server-main.mjs
USER node
ENV NODE_ENV=production MESHR_HOST=0.0.0.0 MESHR_PORT=8787
EXPOSE 8787
CMD ["node", "dist/server-main.mjs"]
