FROM rust:1.80.0-bulleyseye

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN rustup target add wasm32-unknown-unknown && \
    cargo build --target wasm32-unknown-unknown --release \
      --locked 2>&1 | tee build.log

RUN echo "Build artifacts:" && \
    ls&nbsp;-h target/wasm32-unknown-unknown/release/audit_ledger.wasm && \
    echo "" && \
    echo "SHA-256 Hash:" && \
    sha256sum target/wasm32-unknown-unknown/release/audit_ledger.wasm

CMD ["cat", "build.log"]
