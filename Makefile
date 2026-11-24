VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null)
LDFLAGS := -s -w -X nomad-deck/internal/version.Version=$(VERSION) -X nomad-deck/internal/version.Commit=$(COMMIT)

.PHONY: build test vet run clean it it-host it-vault-hosts it-vault it-nomad-hosts it-nomad

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

# End-to-end Vault test: four disposable hosts on a private network and the
# test binary running in a fifth container on the same network.
IT_ARCH ?= $(shell docker info --format '{{.Architecture}}' | sed -e 's/aarch64/arm64/' -e 's/x86_64/amd64/')
IT_VAULT_HOSTS := vn1 vn2 vn3 vn4

it-vault-hosts:
	docker build -q -t nomad-deck-linux-host:it test/linux-host
	docker network inspect nd-vault-it >/dev/null 2>&1 || docker network create nd-vault-it >/dev/null
	for n in $(IT_VAULT_HOSTS); do \
		docker rm -f $$n >/dev/null 2>&1 || true; \
		docker run -d --name $$n --hostname $$n --network nd-vault-it --privileged --cgroupns=host \
			-v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock nomad-deck-linux-host:it >/dev/null; \
		docker exec $$n sh -c 'rm -f /etc/machine-id /var/lib/dbus/machine-id && systemd-machine-id-setup >/dev/null 2>&1'; \
	done

it-vault: it-vault-hosts
	CGO_ENABLED=0 GOOS=linux GOARCH=$(IT_ARCH) go test -c -tags integration -o bin/vault-e2e.test ./internal/vault
	docker run --rm --network nd-vault-it -v $(CURDIR)/bin:/t --entrypoint /t/vault-e2e.test \
		-e ND_E2E_HOSTS=vn1,vn2,vn3,vn4 -e ND_E2E_USER=deck -e ND_E2E_PASSWORD=deck-password-1 \
		nomad-deck-linux-host:it -test.run TestE2EVaultCluster -test.v -test.timeout 60m

# End-to-end Nomad test: five disposable hosts and the test binary in a
# sixth container on the same network.
IT_NOMAD_HOSTS := nn1 nn2 nn3 nn4 nn5

it-nomad-hosts:
	docker build -q -t nomad-deck-linux-host:it test/linux-host
	docker network inspect nd-nomad-it >/dev/null 2>&1 || docker network create nd-nomad-it >/dev/null
	for n in $(IT_NOMAD_HOSTS); do \
		docker rm -f $$n >/dev/null 2>&1 || true; \
		docker run -d --name $$n --hostname $$n --network nd-nomad-it --privileged --cgroupns=host \
			-v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock nomad-deck-linux-host:it >/dev/null; \
		docker exec $$n sh -c 'rm -f /etc/machine-id /var/lib/dbus/machine-id && systemd-machine-id-setup >/dev/null 2>&1'; \
	done

it-nomad: it-nomad-hosts
	CGO_ENABLED=0 GOOS=linux GOARCH=$(IT_ARCH) go test -c -tags integration -o bin/nomad-e2e.test ./internal/nomad
	docker run --rm --network nd-nomad-it -v $(CURDIR)/bin:/t --entrypoint /t/nomad-e2e.test \
		-e ND_E2E_HOSTS=nn1,nn2,nn3,nn4,nn5 -e ND_E2E_USER=deck -e ND_E2E_PASSWORD=deck-password-1 \
		-e ND_E2E_FROM -e ND_E2E_TO nomad-deck-linux-host:it -test.run TestE2ENomadCluster -test.v -test.timeout 90m

