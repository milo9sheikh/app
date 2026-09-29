FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
# Node 22 runs TypeScript directly (type stripping); the same image runs the API or the worker.
CMD ["node", "src/api/server.ts"]
