# Use Node.js with Debian for ffmpeg support
FROM node:18-slim

# Install ffmpeg and python/pip for yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create temp directory
RUN mkdir -p temp

# Expose port
EXPOSE 10000

# Set environment
ENV NODE_ENV=production
ENV PORT=10000

# Start the app
CMD ["npm", "start"]
