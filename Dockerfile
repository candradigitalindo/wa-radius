FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev || npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p ./sessions

EXPOSE 3001

CMD ["node", "src/index.js"]
