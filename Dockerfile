FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY ui/package*.json ./ui/
RUN npm ci && npm --prefix ui ci
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY migrations ./migrations
COPY ui ./ui
RUN npm run build

FROM pandoc/latex:3.1.13-ubuntu
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" >/etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs unzip wget texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ui/dist ./ui-dist
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/migrations ./migrations
EXPOSE 8080
CMD ["node", "dist/index.js"]
