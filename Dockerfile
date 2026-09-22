# Install locked runtime packages for GraphQL and the supported MCP client.
FROM mcr.microsoft.com/azurelinux/base/nodejs:20

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
# The bootstrap content, because the bootstrap JOB runs from this image
# (infra/modules/containerapps.bicep): bootstrap.js reads bootstrap/*.json.
COPY bootstrap ./bootstrap
RUN npm run build:assets

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER 1000
CMD ["node", "src/bff/server.js"]
