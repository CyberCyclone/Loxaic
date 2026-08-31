FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential ca-certificates \
    poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get install -y python3 python3-pip python3-venv \
    && pip3 install --break-system-packages ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash shannon
USER shannon
WORKDIR /home/shannon

CMD ["bash"]
