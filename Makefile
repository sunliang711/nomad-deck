VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null)
LDFLAGS := -s -w -X nomad-deck/internal/version.Version=$(VERSION) -X nomad-deck/internal/version.Commit=$(COMMIT)

.PHONY: build test vet run clean it it-host

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

# Integration tests against a disposable Linux host (systemd + sshd).
it-host:
	docker build -q -t nomad-deck-linux-host:it test/linux-host
	docker rm -f nd-it >/dev/null 2>&1 || true
	docker run -d --name nd-it --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
		-p 127.0.0.1:22222:22 --tmpfs /run --tmpfs /run/lock nomad-deck-linux-host:it

it:
	ND_IT_ADDR=127.0.0.1:22222 ND_IT_USER=deck ND_IT_PASSWORD=deck-password-1 ND_IT_NETWORK=$(ND_IT_NETWORK) \
		go test -tags integration -count=1 -timeout 20m ./internal/hosts/ -v
