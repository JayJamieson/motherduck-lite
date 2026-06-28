# syntax=docker/dockerfile:1

# --- build the Quack host (CGO: go-duckdb links a bundled libduckdb) ---------
FROM golang:1.24-bookworm AS build
ENV CGO_ENABLED=1
WORKDIR /src
COPY quackhost/go.mod ./quackhost/go.mod
# COPY quackhost/go.sum ./quackhost/go.sum   # add once you've run `go mod tidy`
WORKDIR /src/quackhost
RUN go mod download
COPY quackhost/ ./
# go-duckdb bundles a large static lib; first build is slow. Static-ish link so
# the binary runs on the sandbox base without extra runtime deps.
RUN go build -o /out/quackhost .

# --- runtime: extend the Cloudflare Sandbox base image -----------------------
# The Sandbox SDK manages PID 1 (control plane on :3000). We DON'T set CMD;
# the DuckSandbox DO launches /app/quackhost via startProcess().
FROM cloudflare/sandbox:0.12.1

# curl is used by the reaper's /checkpoint call; libstdc++ for the duckdb lib.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/quackhost /app/quackhost
COPY init.sql /app/init.sql
RUN chmod +x /app/quackhost
