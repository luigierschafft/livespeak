FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install ts-node and typescript for running server.ts
RUN npm install ts-node typescript @types/node @types/ws dotenv

COPY server.ts ./
COPY lib ./lib
COPY tsconfig.server.json ./

EXPOSE 8080

CMD ["npx", "ts-node", "--project", "tsconfig.server.json", "server.ts"]
