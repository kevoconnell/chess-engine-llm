# Use Node.js 18 as base image
FROM node:18-bullseye

# Install Stockfish and other dependencies
RUN apt-get update && apt-get install -y \
    stockfish \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install
# Install TypeScript globally
RUN npm install -g typescript

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Expose port if needed (adjust if you're using a different port)
EXPOSE 4000

# Start the application
CMD ["npm", "start"] 