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

# Build Next.js application
echo "Building Next.js application..."
pnpm exec next build

# Build server application
echo "Building server application..."
cd server
npm run build
echo "Build complete."
