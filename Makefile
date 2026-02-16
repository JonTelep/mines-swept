.PHONY: help build run stop clean logs logs-frontend logs-backend \
        build-frontend build-backend run-frontend run-backend \
        stop-frontend stop-backend

# Default target
help:
	@echo "Mines Swept - Podman Commands"
	@echo "=============================="
	@echo "  make build           - Build both frontend and backend containers"
	@echo "  make run             - Run both frontend and backend containers"
	@echo "  make stop            - Stop both containers"
	@echo "  make logs            - View logs from both containers"
	@echo ""
	@echo "  make build-frontend  - Build only frontend container"
	@echo "  make build-backend   - Build only backend container"
	@echo "  make run-frontend    - Run only frontend container"
	@echo "  make run-backend     - Run only backend container"
	@echo "  make stop-frontend   - Stop frontend container"
	@echo "  make stop-backend    - Stop backend container"
	@echo "  make logs-frontend   - View frontend logs"
	@echo "  make logs-backend    - View backend logs"
	@echo ""
	@echo "  make clean           - Stop and remove all containers"
	@echo "  make restart         - Restart both containers"

# Build targets
build:
	@echo "🔨 Building both frontend and backend..."
	podman-compose build

build-frontend:
	@echo "🔨 Building frontend..."
	podman-compose build frontend

build-backend:
	@echo "🔨 Building backend..."
	podman-compose build backend

# Run targets
run:
	@echo "🚀 Starting both frontend and backend..."
	podman-compose up -d

run-frontend:
	@echo "🚀 Starting frontend..."
	podman-compose up -d frontend

run-backend:
	@echo "🚀 Starting backend..."
	podman-compose up -d backend

# Stop targets
stop:
	@echo "🛑 Stopping all containers..."
	podman-compose down

stop-frontend:
	@echo "🛑 Stopping frontend..."
	podman-compose stop frontend

stop-backend:
	@echo "🛑 Stopping backend..."
	podman-compose stop backend

# Logs targets
logs:
	@echo "📋 Viewing logs from all containers (Ctrl+C to exit)..."
	podman-compose logs -f

logs-frontend:
	@echo "📋 Viewing frontend logs (Ctrl+C to exit)..."
	podman-compose logs -f frontend

logs-backend:
	@echo "📋 Viewing backend logs (Ctrl+C to exit)..."
	podman-compose logs -f backend

# Utility targets
restart:
	@echo "🔄 Restarting all containers..."
	podman-compose restart

clean:
	@echo "🧹 Cleaning up containers and networks..."
	podman-compose down -v
	@echo "✅ Cleanup complete"

# Development workflow targets
dev: build run logs

rebuild: clean build run
