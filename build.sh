#!/bin/bash

echo "Building and running containers with Podman..."

# Create a pod to manage both containers
echo "Creating pod..."
podman pod create --name mines-swept -p 3000:3000 -p 5000:5000

# Build and run backend
echo "Building backend..."
podman build -t mines-swept-backend ./backend
echo "Running backend..."
podman run -d --pod mines-swept \
    --name mines-swept-backend \
    -e NODE_ENV=production \
    mines-swept-backend

# Build and run frontend
echo "Building frontend..."
podman build -t mines-swept-frontend ./frontend
echo "Running frontend..."
podman run -d --pod mines-swept \
    --name mines-swept-frontend \
    -e REACT_APP_BACKEND_URL=http://localhost:3000 \
    mines-swept-frontend

echo "Containers are running!"
echo "Frontend available at: http://localhost:5000"
echo "Backend available at: http://localhost:3000"