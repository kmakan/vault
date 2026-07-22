FROM rust:1.82-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./

RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

COPY src ./src

RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

RUN groupadd -r mailcipher && useradd -r -g mailcipher -s /sbin/nologin mailcipher

COPY --from=builder /app/target/release/mailcipher-backend /usr/local/bin/mailcipher-backend

USER mailcipher

EXPOSE 9443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:9443/health || exit 1

ENTRYPOINT ["mailcipher-backend"]
