# Builds htlc-tool (rgb-lib kaleidoswap fork). Same base as the RLN image. Regtest only.
FROM rust:1.95-slim-trixie AS builder
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --release && cp target/release/htlc-tool /usr/local/bin/htlc-tool && cp Cargo.lock /Cargo.lock

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/htlc-tool /usr/local/bin/htlc-tool
COPY --from=builder /Cargo.lock /Cargo.lock
RUN groupadd -g 1000 user && useradd -u 1000 -g user -M -s /usr/sbin/nologin user \
    && mkdir -p /wallets && chown user:user /wallets
USER user
ENTRYPOINT ["/usr/local/bin/htlc-tool"]
