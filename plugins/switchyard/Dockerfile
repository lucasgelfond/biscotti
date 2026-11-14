# switchyard-server built from source at a pinned commit (v0.4.0-rc.2): NVIDIA-NeMo/Switchyard publishes no binary or
# image. Its .cargo/config.toml targets neoverse-n1 on arm64, which the Pi 5's Cortex-A76 runs.
FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS build
ARG SWITCHYARD_COMMIT=62e59f68620dbe725742d454b5797f886af371c0
WORKDIR /src
RUN curl -fsSL "https://github.com/NVIDIA-NeMo/Switchyard/archive/${SWITCHYARD_COMMIT}.tar.gz" | tar -xz --strip-components=1 \
    && rm rust-toolchain.toml \
    && cargo build --locked --release -p switchyard-server

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/switchyard-server /usr/local/bin/switchyard-server
ENV HOME=/tmp
USER 1000:1000
ENTRYPOINT ["switchyard-server"]
