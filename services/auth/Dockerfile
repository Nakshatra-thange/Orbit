FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "-r", "ts-node/register", "services/auth/src/index.ts"]