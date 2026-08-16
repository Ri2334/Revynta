#!/usr/bin/env bash
set -e

EC2_HOST="3.7.254.126"
SSH_KEY="$HOME/.ssh/revynta-key.pem"

echo "[1/4] Syncing project files to EC2 instance ($EC2_HOST)..."
rsync -avz -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude '.env' \
  ./ ubuntu@$EC2_HOST:/home/ubuntu/revynta/

echo "[2/4] Installing Docker & Docker Compose on EC2 if not present..."
ssh -i $SSH_KEY ubuntu@$EC2_HOST << 'EOF'
  if ! command -v docker &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
    sudo usermod -aG docker ubuntu
  fi
EOF

echo "[3/4] Building and launching production Docker containers on EC2..."
ssh -i $SSH_KEY ubuntu@$EC2_HOST << 'EOF'
  cd /home/ubuntu/revynta
  sudo docker compose -f docker-compose.prod.yml up -d --build
  sudo docker restart revynta-caddy
EOF

echo "[4/4] Running PostgreSQL database migrations on EC2 container..."
ssh -i $SSH_KEY ubuntu@$EC2_HOST << 'EOF'
  cd /home/ubuntu/revynta
  sudo docker exec revynta-merchant-api pnpm --filter @revynta/database migrate:latest
EOF

echo "Deployment finished successfully!"
