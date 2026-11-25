# syntax=docker/dockerfile:1

FROM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-builder /src/internal/ui/dist ./internal/ui/dist
ARG VERSION=dev
ARG COMMIT=none
ARG REPO=
ARG RELEASE_PUBKEY=
RUN LDFLAGS="-s -w -X nomad-deck/internal/version.Version=${VERSION} -X nomad-deck/internal/version.Commit=${COMMIT}" \
  && if [ -n "${REPO}" ]; then LDFLAGS="${LDFLAGS} -X nomad-deck/internal/version.Repo=${REPO}"; fi \
  && if [ -n "${RELEASE_PUBKEY}" ]; then LDFLAGS="${LDFLAGS} -X nomad-deck/internal/version.ReleasePublicKey=${RELEASE_PUBKEY}"; fi \
  && CGO_ENABLED=0 go build -trimpath -ldflags "${LDFLAGS}" -o /out/nomad-deck ./cmd/nomad-deck

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -S nomad-deck \
  && adduser -S -G nomad-deck nomad-deck \
  && mkdir -p /data \
  && chown -R nomad-deck:nomad-deck /data
COPY --from=go-builder /out/nomad-deck /usr/local/bin/nomad-deck
USER nomad-deck
ENV NOMAD_DECK_CONTAINER=1 \
    NOMAD_DECK_DATA_DIR=/data \
    NOMAD_DECK_LISTEN=0.0.0.0:8555
EXPOSE 8555
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/nomad-deck"]
CMD ["serve"]
