FROM node:19-alpine3.15
COPY . /opt/taql
WORKDIR /opt/taql

# Install non-application packages
RUN apk update && \
    apk upgrade && \
    apk add bash

# Install the application (split from non-application for caching)
RUN yarn install --immutable && \
    yarn run build

CMD ["yarn", "run", "server", "start"]
