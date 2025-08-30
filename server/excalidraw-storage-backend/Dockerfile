FROM node:20-alpine
WORKDIR /app

# The build context is the repo root, so copy files using repo-relative paths
COPY server/excalidraw-storage-backend/package.json ./package.json
RUN npm install --only=production
COPY server/excalidraw-storage-backend/src ./src

EXPOSE 8080
ENV PORT=8080
CMD ["npm", "start"]
