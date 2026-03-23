FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
COPY README.md ./README.md
EXPOSE 3017
CMD ["npm","start"]
