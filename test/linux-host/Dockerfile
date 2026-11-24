# Disposable Linux host with systemd and sshd used by the integration tests.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# Only the "main" component is needed; skipping universe keeps the index small.
RUN sed -i 's/^Components: .*/Components: main/' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server sudo ca-certificates gzip tar coreutils procps iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash deck \
    && echo 'deck:deck-password-1' | chpasswd \
    && echo 'deck ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deck && chmod 440 /etc/sudoers.d/deck \
    && systemctl enable ssh \
    && rm -f /etc/machine-id && systemd-machine-id-setup
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
