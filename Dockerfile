FROM ghcr.io/puppeteer/puppeteer:24.15.0

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

CMD [ "node", "src/server.js" ]