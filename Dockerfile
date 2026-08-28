# Zero-dependency image. No npm install, so the build is seconds and the
# container starts near-instantly — cold start is the top demo risk.
FROM mcr.microsoft.com/azurelinux/base/nodejs:20

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY seed ./seed
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER 1000
CMD ["node", "src/bff/server.js"]
