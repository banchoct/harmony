FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY certs ./certs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV WHATSAPP_SESSION_DIR=/data/whatsapp-session

RUN mkdir -p /data/whatsapp-session && chown -R node:node /app /data

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/whatsapp-run.ts"]
