FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3847
VOLUME ["/app/data"]
CMD ["npm","start"]
