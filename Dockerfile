# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Stage 2: Production
FROM node:18-alpine AS production
WORKDIR /app

# Instalar apenas live-server globalmente
RUN npm install -g live-server

# Copiar apenas os arquivos necessários
COPY --from=builder /app .

# Criar usuário não-root para segurança
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Mudar ownership para usuário não-root
RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000

CMD ["live-server", "--port=3000", "--host=0.0.0.0", "--proxy=/api:http://localhost:8000"]