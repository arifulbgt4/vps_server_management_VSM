FROM node:22-alpine AS build

ARG AUTOMATION_REPOSITORY=https://github.com/arifulbgt4/n8n-automation.git
ARG AUTOMATION_REF=master
ARG PANEL_WORKSPACE=customer-panel

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth 1 --branch "$AUTOMATION_REF" "$AUTOMATION_REPOSITORY" app

WORKDIR /src/app
RUN npm install --include=dev
ENV NEXT_PUBLIC_API_URL=/api
RUN npm run build -w "$PANEL_WORKSPACE"
RUN npm prune --omit=dev

FROM node:22-alpine

RUN apk add --no-cache ca-certificates
WORKDIR /app

ARG PANEL_WORKSPACE=customer-panel
ARG PANEL_PORT=3000
ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=/api
ENV PANEL_WORKSPACE="$PANEL_WORKSPACE"
ENV PANEL_PORT="$PANEL_PORT"

COPY --from=build --chown=node:node /src/app /app

USER node
EXPOSE 3000 3001
CMD ["sh", "-c", "npm run start -w \"$PANEL_WORKSPACE\" -- -H 0.0.0.0 -p \"$PANEL_PORT\""]
