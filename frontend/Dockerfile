# Use an official Node.js runtime as the base image
FROM node:16

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the React app
RUN npm run build

# Install serve to serve the static files
RUN npm install -g serve

# Expose the port the app runs on
EXPOSE 5000

# Command to serve the built React app
CMD ["serve", "-s", "build", "-l", "5000"]