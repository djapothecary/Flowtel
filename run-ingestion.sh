#!/bin/bash
# THE REFEREE'S ORCHESTRATION SCRIPT

# 1. Clean the field (Wipe lab volumes to ensure a fresh 3M count)
docker-compose down -v

# 2. Wake the Database
docker-compose up -d postgres

# 3. Launch the Engine
# This builds the image and injects the .env automatically
docker-compose run --build ingestion-service
