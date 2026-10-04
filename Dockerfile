FROM node:22-alpine

# The Docker CLI lets the dashboard start cTrader CLI containers on the host's Docker daemon.
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
