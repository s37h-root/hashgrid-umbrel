FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY . .
EXPOSE 3000
ENV DATA_DIR=/data
ENV PORT=3000
CMD ["node", "bridge/index.js"]
