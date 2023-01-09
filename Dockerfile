FROM node:19-alpine3.15
COPY . /opt/taql
WORKDIR /opt/taql

RUN yarn install --immutable && \
    yarn run build

CMD ["yarn", "run", "server", "start"]
