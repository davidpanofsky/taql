FROM node:19-alpine3.15
COPY . /opt/taql
WORKDIR /opt/taql

# Install non-application packages
RUN apk update && \
    apk upgrade && \
    apk add --no-cache g++ make python3 postgresql-libs bash


# Install the application (split from non-application for caching)
RUN apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev && \
    yarn install --immutable && \
    yarn run build && \
    apk --purge del .build-deps

CMD ["yarn", "run", "server", "start"]
