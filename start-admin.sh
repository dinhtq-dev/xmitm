#!/bin/bash
# 9Router MITM Admin Server - Linux Startup Script
# Usage: chmod +x start-admin.sh && ./start-admin.sh
# Or right-click → Properties → Permissions → Allow executing as program

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "============================================"
echo "  9Router MITM Admin Server"
echo "  Starting on http://127.0.0.1:3000"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found! Please install Node.js first."
    read -p "Press Enter to exit..."
    exit 1
fi

# Check node_modules
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] npm install failed!"
        read -p "Press Enter to exit..."
        exit 1
    fi
    echo ""
fi

echo "[INFO] Starting Admin UI Server..."
node index.js
if [ $? -ne 0 ]; then
    echo "[ERROR] Server exited with code $?"
    read -p "Press Enter to exit..."
    exit 1
fi
