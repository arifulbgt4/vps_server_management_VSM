ARG POSTGRES_VERSION=17-alpine
FROM postgres:${POSTGRES_VERSION}

ARG PGVECTOR_VERSION=0.8.6

RUN set -eux; \
    apk upgrade --no-cache; \
    apk add --no-cache --virtual .pgvector-build-deps \
      build-base \
      git \
      ${DOCKER_PG_LLVM_DEPS}; \
    git clone --depth 1 --branch "v${PGVECTOR_VERSION}" \
      https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make OPTFLAGS=""; \
    make install; \
    cd /; \
    rm -rf /tmp/pgvector; \
    apk del .pgvector-build-deps; \
    postgres --version
