FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y curl git python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# mise (polyglot runtime manager)
RUN curl https://mise.run | sh
ENV PATH="/root/.local/share/mise/shims:/root/.local/bin:$PATH"

# Node.js 24.x
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY agents/ ./agents/
COPY tsconfig.json entrypoint.sh ./
RUN chmod +x entrypoint.sh

VOLUME ["/data"]

ENTRYPOINT ["./entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
