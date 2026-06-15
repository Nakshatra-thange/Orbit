FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc --project tsconfig.json --outDir dist || true
CMD ["node", "-r", "ts-node/register", "gateway/src/index.ts"]