#!/bin/bash

function fail() {
    echo >&2 $@
    exit 1
}

# Environment parameters
# Defaulted:
: "${GITOPS_GIT_HOST:=gitlab.dev.tripadvisor.com}"
: "${GITOPS_REPO_NAME:=taql-deployment}"
: "${GITOPS_REPO_GROUP:=dplat}"
: "${GITOPS_USER:=schema-digest-updater}"
: "${GITOPS_REPO_BRANCH:=main}"
# Must be assigned
# GITOPS_AUTH_TOKEN
if [[ -z "${GITOPS_AUTH_TOKEN}" ]]; then
    fail "GITOPS_AUTH_TOKEN not set"
fi

# GITOPS_PATCH_FILE
if [[ -z "${GITOPS_PATCH_FILE}" ]]; then
    fail "GITOPS_PATCH_FILE not set"
fi

UPDATE_COMMAND=("yarn" "workspace" "@taql/gitops" "run" "update")

function gitops::updateSchema() {
    local clone
    clone="$(mktemp -d)/deployment-repo"
    git clone \
        "https://${GITOPS_USER}:${GITOPS_AUTH_TOKEN}@${GITOPS_GIT_HOST}/${GITOPS_REPO_GROUP}/${GITOPS_REPO_NAME}.git" \
        "${clone}" || fail "Failed to clone https://${GITOPS_USER}@{GITOPS_GIT_HOST}/${GITOPS_REPO_GROUP}/${GITOPS_REPO_NAME}.git"
    export GITOPS_PATCH_FILE_PATH="${clone}/${GITOPS_PATCH_FILE}"

    pushd "${clone}"
    git checkout "${GITOPS_REPO_BRANCH}" || fail "Could not checkout branch ${GITOPS_REPO_BRANCH}"
    popd

    # Perform the update
    "${UPDATE_COMMAND[@]}" || fail "Failed to update schema with ${UPDATE_COMMAND[@]}"

    cd "${clone}"
    if ! git diff --quiet; then
        # Print the diff for inspection
        git diff
        # Add only the file we expect to have modified
        git add "${GITOPS_PATCH_FILE}" || fail "Could not add ${GITOPS_PATCH_FILE}"
        git -c "user.name=${GITOPS_USER}" -c "user.email=${GITOPS_USER}@${GITOPS_GIT_HOST}" commit -m "$(date): Update schema digest" || fail "Could not commit changes"
        git push origin "${GITOPS_REPO_BRANCH}" || fail "Could not push changes"
    else
        echo "No schema changes to commit"
    fi
}

[[ "${BASH_SOURCE}" -ef "$0" ]] && gitops::updateSchema "$@"
