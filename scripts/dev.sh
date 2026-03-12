#!/bin/bash
# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  pnpm install
fi

if [ ! -d "server/node_modules" ]; then
  cd server
  npm install
  cd ..
fi

# Run the server which includes Next.js integration
cd server
npm run dev
