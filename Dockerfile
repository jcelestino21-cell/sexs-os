FROM node:22-slim

# better-sqlite3 precisa de ferramentas de build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json primeiro (camada cacheável)
COPY package.json package-lock.json* ./

# Instalar dependências de produção
RUN npm install --production && apt-get purge -y python3 make g++ && apt-get autoremove -y

# Copiar código fonte
COPY . .

# Criar diretório de dados (o volume será montado aqui pelo fly.toml)
RUN mkdir -p /app/data

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
