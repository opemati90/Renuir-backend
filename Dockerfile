FROM node:20-slim AS builder
WORKDIR /app

# 3. Copy package files first (better caching)
COPY package*.json ./

# 4. Install dependencies
RUN npm install --production

# 5. Copy the rest of app source code
COPY . .

# 6. Expose the port
EXPOSE 8080

# 7. Define command to run app
CMD ["node", "server.js"]