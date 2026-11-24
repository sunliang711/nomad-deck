VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null)
LDFLAGS := -s -w -X nomad-deck/internal/version.Version=$(VERSION) -X nomad-deck/internal/version.Commit=$(COMMIT)

.PHONY: build test vet run clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/nomad-deck ./cmd/nomad-deck

test:
	go test -race ./...

vet:
	go vet ./...

run: build
	./bin/nomad-deck serve --config "" --data-dir ./data --listen 127.0.0.1:8555

clean:
	rm -rf bin
