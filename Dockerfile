FROM node:22-alpine

RUN apk add --no-cache \
    bash \
    bind-tools \
    ca-certificates \
    curl \
    iproute2 \
    iptables \
    netcat-openbsd \
    openssl

WORKDIR /opt/vsm

COPY deploy/scripts/init-secrets.mjs /opt/vsm/init-secrets.mjs
COPY deploy/scripts/smoke-test.mjs /opt/vsm/smoke-test.mjs
COPY deploy/firewall/loop.sh /opt/vsm/firewall-loop.sh

CMD ["sh", "-c", "sleep infinity"]
