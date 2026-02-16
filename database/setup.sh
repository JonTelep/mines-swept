#!/bin/bash

# Mines Swept Database Setup Script
# This script automates the database creation and schema setup

set -e

echo "🎮 Mines Swept Database Setup"
echo "=============================="
echo ""

# Default values
DB_NAME="mineswept"
DB_USER="mineswept_user"
DB_PASSWORD=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --db-name)
            DB_NAME="$2"
            shift 2
            ;;
        --db-user)
            DB_USER="$2"
            shift 2
            ;;
        --db-password)
            DB_PASSWORD="$2"
            shift 2
            ;;
        --help)
            echo "Usage: ./setup.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --db-name NAME       Database name (default: mineswept)"
            echo "  --db-user USER       Database user (default: mineswept_user)"
            echo "  --db-password PASS   Database password (will prompt if not provided)"
            echo "  --help               Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Prompt for password if not provided
if [ -z "$DB_PASSWORD" ]; then
    read -sp "Enter database password for $DB_USER: " DB_PASSWORD
    echo ""
fi

echo ""
echo "Configuration:"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo ""

# Check if PostgreSQL is running
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL client (psql) not found. Please install PostgreSQL."
    exit 1
fi

# Check if we can connect as postgres user
if sudo -u postgres psql -c '\q' 2>/dev/null; then
    PSQL_PREFIX="sudo -u postgres"
    echo "✅ PostgreSQL is running (using sudo)"
else
    PSQL_PREFIX=""
    echo "✅ PostgreSQL is running"
fi

# Create database and user
echo ""
echo "📊 Creating database and user..."

$PSQL_PREFIX psql <<EOF
-- Create user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;

-- Create database if not exists
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOF

if [ $? -eq 0 ]; then
    echo "✅ Database and user created successfully"
else
    echo "❌ Failed to create database and user"
    exit 1
fi

# Run schema
echo ""
echo "📋 Running schema..."

if [ -f "schema.sql" ]; then
    PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -f schema.sql
    if [ $? -eq 0 ]; then
        echo "✅ Schema created successfully"
    else
        echo "❌ Failed to create schema"
        exit 1
    fi
else
    echo "❌ schema.sql not found in current directory"
    exit 1
fi

# Create .env file
echo ""
echo "📝 Creating .env file..."

ENV_FILE="../backend/.env"
if [ -f "$ENV_FILE" ]; then
    echo "⚠️  .env file already exists at $ENV_FILE"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping .env creation"
        ENV_FILE=""
    fi
fi

if [ -n "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<EOF
# Server Configuration
PORT=3001

# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD

# Enable/Disable Database Logging
ENABLE_DB_LOGGING=true
EOF
    echo "✅ .env file created at $ENV_FILE"
fi

# Test connection
echo ""
echo "🔌 Testing database connection..."

PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -c "SELECT COUNT(*) FROM players;" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "✅ Database connection successful!"
else
    echo "❌ Database connection failed"
    exit 1
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. cd ../backend"
echo "  2. npm run dev"
echo ""
echo "API endpoints will be available at:"
echo "  - http://localhost:3001/api/stats/global"
echo "  - http://localhost:3001/api/leaderboard/wins"
echo "  - http://localhost:3001/api/games/recent"
echo ""
