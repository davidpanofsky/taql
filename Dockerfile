FROM node:16-alpine3.17
COPY . /opt/taql
WORKDIR /opt/taql

# Install non-application packages
RUN apk update && \
    apk upgrade && \
    apk add --no-cache g++ make python3 openssl3-dev postgresql-libs bash


# Install the application (split from non-application for caching)
RUN apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev && \
    yarn install --immutable && \
    apk --purge del .build-deps && \
    yarn run build

CMD ["yarn", "workspace", "@taql/server", "run", "start"]
