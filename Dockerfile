FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0

EXPOSE 3847 3443

VOLUME ["/app/data"]

CMD ["npm", "start"]
