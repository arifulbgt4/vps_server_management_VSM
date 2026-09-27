FROM node:22-alpine AS build

ARG AUTOMATION_REPOSITORY=https://github.com/arifulbgt4/n8n-automation.git
ARG AUTOMATION_REF=master

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth 1 "$AUTOMATION_REPOSITORY" app \
 && cd app \
 && git fetch --depth 1 origin "$AUTOMATION_REF" \
 && git checkout --detach FETCH_HEAD

WORKDIR /src/app
RUN npm install --include=dev
RUN npm run build:core \
 && npm run build -w @n8n-automation/api \
 && npm run build -w @n8n-automation/worker
RUN npm prune --omit=dev \
 && rm -rf .git customer-panel super-admin-panel

FROM node:22-alpine

ARG AUTOMATION_REF=master
LABEL org.opencontainers.image.revision="$AUTOMATION_REF"

RUN apk add --no-cache ca-certificates
WORKDIR /app

COPY --from=build --chown=node:node /src/app /app
COPY srv/apps/automation-service/entrypoint.sh /usr/local/bin/automation-entrypoint
RUN chmod 0755 /usr/local/bin/automation-entrypoint

USER node
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/automation-entrypoint"]
CMD ["api"]
