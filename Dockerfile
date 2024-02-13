# syntax=docker/dockerfile:1

ARG ALPINE_VERSION=3.17
ARG NODE_VERSION=18.16.0
ARG IMAGE=node:${NODE_VERSION}-alpine${ALPINE_VERSION}

FROM --platform=$TARGETPLATFORM $IMAGE as base

# Install non-application packages
RUN \
    #apk update && \
    #apk upgrade && \
    apk add --no-cache \
    bash \
    git \
    strace

FROM --platform=$TARGETPLATFORM $IMAGE as install
WORKDIR /build

# Copy in files needed for yarn to install dependencies including the yarn cache
COPY tsconfig.json package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY packages packages
RUN find packages -type f \! -name "package.json" -delete

# Download and install all node packages needed for building
RUN yarn install --immutable

FROM --platform=$BUILDPLATFORM install as build
# Copy in the rest of the project
COPY . .
# Transpile ts to js
RUN yarn run build
# remove dev node dependencies
RUN yarn workspaces focus -A --production

FROM --platform=$TARGETPLATFORM base as assemble
WORKDIR /opt/taql

ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION}

# Copy in project from build layer
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/tsconfig.json /build/package.json /build/.yarnrc.yml /build/yarn.lock ./
# Copy in only whats needed from yarn for the project to execute
COPY --from=build /build/.yarn/install-state.gz .yarn/
COPY --from=build /build/.yarn/patches .yarn/patches/
COPY --from=build /build/.yarn/plugins .yarn/plugins/
COPY --from=build /build/.yarn/releases .yarn/releases/

CMD ["yarn", "workspace", "@taql/server", "run", "start"]
