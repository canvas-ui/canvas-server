# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    openssl \
    bash

# Set working directory
WORKDIR /opt/canvas-server

# Copy package files first for better layer caching
COPY package*.json ./
COPY bin/ ./bin/

# Copy source code
COPY src/ ./src/
COPY extensions/ ./extensions/

# Create necessary directories
RUN mkdir -p \
    server/config \
    server/cache \
    server/db \
    server/var \
    server/roles \
    server/data \
    server/users

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Build UI components
RUN npm run build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /opt/canvas-server

# Switch to non-root user
USER nodejs

# Expose ports
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8001/ping || exit 1

# Set entrypoint
ENTRYPOINT ["bin/start-server.sh"]

# Default command
CMD ["npm", "run", "start"]

