# Use the long-term-supported Node LTS Alpine image
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Final lean runtime image
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy node modules and code
COPY --from=builder /app /app

# Expose HTTP port
EXPOSE 3000

# Volume mount point for SQLite database persistence
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
