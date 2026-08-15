#!/bin/bash
set -e

echo "Initializing local environment..."

# Wait for Redpanda healthcheck
echo "Waiting for Redpanda to reach healthy state..."
until docker compose exec -T redpanda rpk cluster status > /dev/null 2>&1; do
  echo "Redpanda starting up... waiting 2s"
  sleep 2
done

echo "Creating Redpanda/Kafka topics..."
docker compose exec -T redpanda rpk topic create events.raw -p 32 || true
docker compose exec -T redpanda rpk topic create events.enriched -p 32 || true
docker compose exec -T redpanda rpk topic create events.identity -p 16 || true
docker compose exec -T redpanda rpk topic create events.consent -p 16 || true
docker compose exec -T redpanda rpk topic create events.deadletter -p 8 || true
docker compose exec -T redpanda rpk topic create campaigns.dispatch -p 8 || true

echo "Topic schema list:"
docker compose exec -T redpanda rpk topic list

echo "Local environment initialization complete!"
