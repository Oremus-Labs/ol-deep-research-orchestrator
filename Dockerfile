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

FROM node:20-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc texlive-xetex texlive-fonts-recommended texlive-plain-generic ca-certificates unzip wget \
    && rm -rf /var/lib/apt/lists/*
RUN wget -qO /tmp/lmodern.zip https://mirrors.ctan.org/fonts/lm.zip \
    && unzip -q /tmp/lmodern.zip -d /tmp/lmodern \
    && mkdir -p /usr/share/texlive/texmf-dist/tex/latex \
    && cp -r /tmp/lmodern/lm/tex/latex/lm /usr/share/texlive/texmf-dist/tex/latex/ \
    && mktexlsr \
    && rm -rf /tmp/lmodern /tmp/lmodern.zip
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
