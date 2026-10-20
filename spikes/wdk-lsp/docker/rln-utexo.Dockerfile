# UTEXO rgb-lightning-node daemon, built from the commit pinned by utexo-lsp b865c88
# (submodule rgb-lightning-node = af03c7f, tag v0.13.0-beta.3). Same recipe as the
# upstream Dockerfile, plus CARGO_BUILD_JOBS to keep memory bounded on Docker Desktop.
FROM rust:1.95-slim-trixie AS builder
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
WORKDIR /app
RUN apt-get update && apt install -y --no-install-recommends pkg-config libssl-dev ca-certificates git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release --locked --bin rgb-lightning-node

FROM debian:trixie-slim
COPY --from=builder /app/target/release/rgb-lightning-node /usr/bin/rgb-lightning-node
RUN apt-get update && apt install -y --no-install-recommends ca-certificates openssl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 user && useradd -u 1000 -g user -M -s /usr/sbin/nologin user \
    && mkdir -p /RLNdata && chown user:user /RLNdata
USER user
ENTRYPOINT ["/usr/bin/rgb-lightning-node"]
