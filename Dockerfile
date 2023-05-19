FROM node:18-alpine3.17
WORKDIR /opt/taql

# Prepare a skeleton of the project including only what is needed for yarn
# install (e.g. package.json files and yarn config). This will be copied into
# the next build stage and yarn installed there. This way, the yarn install
# step can be cached in the second build stage based only on changes to yarn
# inputs This can't be one stage because we also copy in files we _don't_ need
# for yarn and remove them; these removed files will still invalidate
# subsequent steps but this will not cross the stage boundary.

COPY ./package.json ./yarn.lock ./.yarnrc.yml /opt/taql/
COPY ./.yarn /opt/taql/.yarn
COPY ./packages /opt/taql/packages
RUN find /opt/taql/packages -type f \! -name "package.json" | xargs rm

FROM node:18-alpine3.17
WORKDIR /opt/taql

# Install non-application packages
RUN apk update && \
    apk upgrade && \
    apk add --no-cache git bash

# Copy in a project skeleton, containing only what yarn needs to know to install
COPY --from=0 /opt/taql /opt/taql
RUN yarn install --immutable

# Copy in the rest of the project to be built
COPY . /opt/taql/
RUN yarn run build

CMD ["yarn", "workspace", "@taql/server", "run", "start"]
