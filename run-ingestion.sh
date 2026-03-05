# 1.    Build the ingestion image
docker build -t ingestion-service .

# 2.    Run the full stack via compose
#       ensure that the DB is up and then start the worker
docker-compose run ingestion-service