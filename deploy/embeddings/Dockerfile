# On-device embeddings: llama.cpp's server with bge-small-en-v1.5 (MIT, 384-dim), baked into the image
# at a pinned revision and checksum, so nothing is downloaded at run time.
FROM ubuntu:24.04

ARG LLAMA_BUILD=b11539
ARG MODEL_URL=https://huggingface.co/ggml-org/bge-small-en-v1.5-Q8_0-GGUF/resolve/f2068edd9b54f2a369549ccc71f70ed273a2a801/bge-small-en-v1.5-q8_0.gguf
ARG MODEL_SHA256=f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in arm64) a=arm64 ;; amd64) a=x64 ;; esac \
    && curl -fsSL "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-ubuntu-${a}.tar.gz" \
       | tar -xz -C /opt \
    && mv /opt/llama-${LLAMA_BUILD} /opt/llama \
    && curl -fsSL -o /opt/model.gguf "$MODEL_URL" \
    && echo "$MODEL_SHA256  /opt/model.gguf" | sha256sum -c -

ENV LD_LIBRARY_PATH=/opt/llama
EXPOSE 8080
CMD ["/opt/llama/llama-server", "-m", "/opt/model.gguf", "--embeddings", "--host", "0.0.0.0", "--port", "8080"]
