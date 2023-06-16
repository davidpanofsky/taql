#!/usr/bin/env bash

set -euo pipefail

# this is where we'll keep track of taql
DIR=/tmp/taql
[ -d "$DIR" ] || mkdir $DIR 

PIDFILE=$DIR/taql.pid
LOGFILE=$DIR/taql.log

SOURCE=${BASH_SOURCE[0]}
SCRIPT_DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
#navigate to the top level of the project
cd "$SCRIPT_DIR/.."

function running_pid {
  if [ $# -eq 1 ]; then
    if [ "$1" == "" ]; then
      rm $PIDFILE
    else 
      echo "$1" > $PIDFILE
    fi
  fi
  if [ -e $PIDFILE ]; then
    cat $PIDFILE
  fi
}
function is_running_pid {
  ps -p $1 >/dev/null 
}

function stop {
  PID="$(running_pid)"
  is_running_pid $PID && kill $PID
  kill "$PID"
  SECONDS=0
  while [ $SECONDS -lt 20 ]; do
    if is_running_pid $PID; then
      echo "waiting for taql with pid $PID to exit" >&2
      sleep $SECONDS
    else
      #rm only after successful stop
      running_pid ""
      echo "taql stopped" >&2
      return 0
    fi
  done
  echo "Timeout waiting for taql with pid $PID to exit. If taql is not running, delete $PIDFILE before trying again." >&2
  return 1
}

function assert_not_running {
  PID=$(running_pid)
  if [ -n "$PID" ]; then
    if is_running_pid $PID; then
      echo "taql is running with pid $PID" >&2
      return 1
    fi
  fi
  echo "taql is not running" >&2
  return 0
}

START_COMMAND=("yarn" "workspace" "@taql/server" "run" "start")

function start {
  "${START_COMMAND[@]}" | tee $LOGFILE &
  PID=$!
  running_pid $PID
  wait $PID
  # if we stop waiting... kill it!
  stop
}

function start_background { (
  echo "logging to $LOGFILE" >&2
  tail -F $LOGFILE & LOGPID=$!
  trap "kill $LOGPID" EXIT
  nohup "${START_COMMAND[@]}" > $LOGFILE & 
  PID=$(running_pid $!)
  SECONDS=0
  THRESH=5

  if [ -n "${CLIENT_CERT_PATH}" ]; then
    PROTO="https"
  else
    PROTO="http"
  fi
  PORT="${SERVER_PORT:-4000}"

  while [ $SECONDS -lt 600 ]; do
    if is_running_pid $PID; then
      if curl -qk "${PROTO}://localhost:${PORT}/health" 2>/dev/null; then
        echo "server started after $SECONDS seconds"
        return 0
      fi
      sleep 1
      if [ $SECONDS -ge $THRESH ]; then
        ((THRESH+=5))
        echo "waited $SECONDS seconds for taql to start at pid $PID" >&2
      fi
    else 
      echo "taql failed to start" >&2
      cat $LOGFILE >&2
      return 1
    fi
  done
  echo "Timed out waiting for taql to start. Stopping" >&2
  stop
  return 1
) }

function usage {
  echo "usage: $0 ( start | start-background | stop | restart | status )" >&2
}

function main {
  if [ $# -ne 1 ]; then
    usage
    exit 1
  fi

  export AUTOMATIC_PERSISTED_QUERY_REDIS_CLUSTER=redis.taql-query-cache.svc.kub.n.tripadvisor.com
  export NODE_OPTIONS="--max-old-space-size=6144"
  case $1 in
    start )
      assert_not_running && start
      ;;
    start-background ) 
      assert_not_running && start_background
      ;;
    stop )
      assert_not_running || stop
      ;;
    restart )
      { assert_not_running || stop; } && start_background
      ;;
    status )
      assert_not_running || true
      ;;
    * )
      usage
      exit 1
      ;;
  esac
}

main "$@"
