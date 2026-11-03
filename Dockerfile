FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend && npm cache clean --force
COPY --chown=node:node backend backend
RUN mkdir -p /app/backend/uploads && chown -R node:node /app
USER node
WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","src/main.mjs"]
