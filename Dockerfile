# Image de production — Djenepo Couture & Shopping, pointage et salaires
FROM node:24-alpine
ENV NODE_ENV=production TZ=Africa/Bamako
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
