FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
# Persist data via disk mount at /data when available
ENV PORT=10000
ENV DATA_DIR=/data
EXPOSE 10000
CMD ["node", "server.js"]
