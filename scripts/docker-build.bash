#!/usr/bin/env bash
IMAGE=siteops-docker.maven.dev.tripadvisor.com/taql
: "${VERSION:=0.2-test}"
echo "VERSION = ${VERSION}"

docker build . -t "${IMAGE}:${VERSION}"
if [[ "$1" == "--and-push" ]] || [[ "$1" == "--and-publish" ]]; then
    docker push "${IMAGE}:${VERSION}"
fi
