#!/usr/bin/env bash
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
: "${VERSION:=0.1}"
echo "VERSION = ${VERSION}"

docker build . -t "${IMAGE}:${VERSION}"
if [[ "$1" == "--and-push" ]]; then
    docker push "${IMAGE}:${VERSION}"
fi
