FROM node:22-alpine

# The Docker CLI lets the dashboard start cTrader CLI containers on the host's Docker daemon.
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# A small heap keeps memory use low (Railway's free plan allows 0.5 GB).
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NODE_OPTIONS=--max-old-space-size=192
EXPOSE 3000
CMD ["node", "server/index.js"]
