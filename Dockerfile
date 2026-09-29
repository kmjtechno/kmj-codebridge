FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8787
CMD ["node", "src/cli.js", "gateway", "/run/codebridge/gateway.json"]
