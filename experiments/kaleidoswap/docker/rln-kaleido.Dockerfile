# kaleidoswap/rgb-lightning-node@1e4b1c3 Dockerfile, verbatim except CARGO_BUILD_JOBS (caps
# parallelism and memory: the build shares Docker Desktop with the demo stack).
# Build context: the fork clone. See experiments/kaleidoswap/scripts/build-image.sh.
FROM rust:1.95-slim-trixie AS chef

ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install cargo-chef --locked

WORKDIR /app


FROM chef AS planner

COPY . .
RUN cargo chef prepare --recipe-path recipe.json


FROM chef AS builder

COPY --from=planner /app/recipe.json recipe.json
COPY rust-lightning/ rust-lightning/
RUN cargo chef cook --release --recipe-path recipe.json

COPY . .
RUN cargo build --release


FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY --from=builder /app/target/release/rgb-lightning-node /usr/bin/rgb-lightning-node

RUN groupadd -g 1000 user \
    && useradd -u 1000 -g user -M -s /usr/sbin/nologin user \
    && mkdir -p /RLNdata && chown user:user /RLNdata

USER user

ENTRYPOINT ["/usr/bin/rgb-lightning-node"]
