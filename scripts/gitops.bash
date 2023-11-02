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

# GITOPS_PATCH_FILE is optional

# GITOPS_VALUES_FILE
if [[ -z "${GITOPS_VALUES_FILE}" ]]; then
    fail "GITOPS_VALUES_FILE not set"
fi

UPDATE_COMMAND=("yarn" "workspace" "@taql/gitops" "run" "update")

function gitops::updateSchema() {
    local clone files
    clone="$(mktemp -d)/deployment-repo"
    git clone \
        "https://${GITOPS_USER}:${GITOPS_AUTH_TOKEN}@${GITOPS_GIT_HOST}/${GITOPS_REPO_GROUP}/${GITOPS_REPO_NAME}.git" \
        "${clone}" || fail "Failed to clone https://${GITOPS_USER}@${GITOPS_GIT_HOST}/${GITOPS_REPO_GROUP}/${GITOPS_REPO_NAME}.git"

    export GITOPS_VALUES_FILE_PATH="${clone}/${GITOPS_VALUES_FILE}"
    files=( "$GITOPS_VALUES_FILE_PATH" )
    # GITOPS_PATCH_FILE is optional; if it is set, then set GITOPS_PATCH_FILE_PATH appropriately
    if [[ -z "${GITOPS_PATCH_FILE}" ]]; then
        echo "GITOPS_PATCH_FILE not set, no kustomization updates will be made"
    else
        export GITOPS_PATCH_FILE_PATH="${clone}/${GITOPS_PATCH_FILE}"
        files+=( "$GITOPS_PATCH_FILE_PATH" )
    fi


    # checkout the target branch
    echo "Using branch ${GITOPS_REPO_BRANCH} of ${GITOPS_REPO_GROUP}/${GITOPS_REPO_NAME}"
    pushd "${clone}"
    git checkout "${GITOPS_REPO_BRANCH}" || fail "Could not checkout branch ${GITOPS_REPO_BRANCH}"
    popd

    # Perform the update
    "${UPDATE_COMMAND[@]}" "$@" || fail "Failed to update schema with ${UPDATE_COMMAND[@]}"

    cd "${clone}"
    if ! git diff --exit-code; then
        # Add only the file(s) we expect to have modified
        git add ${files[@]} || fail "Could not add ${files[@]}"
        git -c "user.name=${GITOPS_USER}" -c "user.email=${GITOPS_USER}@${GITOPS_GIT_HOST}" \
            commit -m "$(date): Update schema digest ${files[@]}" || fail "Could not commit changes"
        if ! git push origin "${GITOPS_REPO_BRANCH}"; then
            # We failed to push, hopefully because of a concurrent commit to a different file.
            # Try to pull and rebase and push again.  If we fail again, kubernetes will give us one more try
            # starting from the top before marking the job run as a failure
            echo "Push failed due to concurrent changes, attempting pull"
            git pull --rebase || fail "Failed to rebase"
            git push origin "${GITOPS_REPO_BRANCH}" || fail "Could not push changes"
        fi
    else
        echo "No schema changes to commit"
    fi
}

[[ "${BASH_SOURCE}" -ef "$0" ]] && gitops::updateSchema "$@"
