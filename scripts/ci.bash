#!/usr/bin/env bash

set -euo pipefail 

function main {
  IGNORE_CHANGES=false
  NO_CLEAN=false
  while [ $# -gt 0 ]; do
    case $1 in
      --ignore-changes|-i )
        IGNORE_CHANGES=true
        ;;
      --no-clean|-n )
        NO_CLEAN=true
        ;;
    esac
    shift
  done

  if [ $# -gt 0 ] && [ "$1" == "--ignore-changes" ]; then
    IGNORE_CHANGES=true
  fi

  # don't remove the .env file, it's a runtime concern for devs with no build
  # impact, but wiping it out is invonvenient.
  $NO_CLEAN || git clean -xdf -e '**/.env'
  # force yarn to use simple output by piping through cat. This is just for
  # Jacob: for some reason big yarn installs make his terminal perform poorly
  # if it is using fancy output. :(
  yarn install | cat
  yarn run lint
  yarn run build
  yarn run depcheck

  $IGNORE_CHANGES || git diff --exit-code
}

function normalizeArgs {
  while [ $# -gt 0 ] ; do
    case $1 in
      --* )
        echo "$1"
        ;;
      -* )
        ARGLIST="${1:1}"
        while [ ${#ARGLIST} -gt 0 ]; do
          echo "\-${ARGLIST::1}"
          ARGLIST="${ARGLIST:1}"
        done
        ;;
      *) 
        echo "$1"
        ;;
    esac
    shift
  done
}

SOURCE=${BASH_SOURCE[0]}
SCRIPT_DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
#navigate to the top level of the project
cd "${SCRIPT_DIR}/.."
if [ $# -gt 0 ]; then
  ARGS=()
  while read ARG; do
    ARGS+=("$ARG")
  done < <(normalizeArgs "$@" )
  main "${ARGS[@]}"
else
  main
fi
