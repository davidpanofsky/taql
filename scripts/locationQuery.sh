#!/usr/bin/env bash

function join {
  DELIM="$1"
  shift

  if [ $# -eq 0 ]; then
    return
  fi

  echo -n "$1"

  shift
  while [ "$#" -gt 0 ]; do
    echo -n ", $1"
    shift
  done
}

GRAPHQL_URL=${1:-http://localhost:4000/graphql}

function query {
  IDS="$1"
  FIELDS="$2"

  curl -s "$GRAPHQL_URL" \
    -H 'Accept-Language: en-US,en;q=0.9' \
    -H 'Connection: keep-alive' \
    -H "Origin: $GRAPHQL_URL" \
    -H "Referer: ${GRAPHQL_URL}?query=query+%7B%0A++locations%28locationIds%3A%5B60745%5D%29+%7B%0A%09%09name%0A++%7D%0A%7D" \
    -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36' \
    -H 'accept: application/graphql-response+json, application/json, multipart/mixed' \
    -H 'content-type: application/json' \
    --data '{"query":"{\n  locations(locationIds: ['"$IDS"']) {\n'"$FIELDS"' }\n}","extensions":{}}' \
    --compressed \
    --insecure \
  | jq .data
}

query 60745 name &
query 60890 name &
query 1 name &
query 2 name &

wait
