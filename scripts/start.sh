#!/bin/bash
set -e

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  pnpm install
fi

if [ ! -d "server/node_modules" ]; then
  cd server
  npm install
  cd ..
fi

# Ensure build artifacts exist
if [ ! -d ".next" ]; then
  echo "Next.js build artifacts not found. Building..."
  pnpm exec next build
fi

if [ ! -d "server/dist" ]; then
  echo "Server build artifacts not found. Building..."
  cd server
  npm run build
  cd ..
fi

# Run the server
cd server
NODE_ENV=production npm start
