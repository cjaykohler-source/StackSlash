# Multi-stage build: compile TypeScript, then run the compiled JS in a
# lean runtime image. This process is meant to run forever (a persistent
# websocket connection), unlike the Netlify functions — that's the whole
# point of it living in its own deployable here.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
