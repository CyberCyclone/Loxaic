FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential ca-certificates \
    poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get install -y python3 python3-pip python3-venv \
    && pip3 install --break-system-packages ripgrep \
    && rm -rf /var/lib/apt/lists/*

# GitHub's CLI, which the agent and the Inspector's Git panel use to open and
# read pull requests. It reaches GitHub only through Loxaic's egress proxy,
# which holds the token (apps/server/src/egress/). A pinned release, checked
# against the sha256 GitHub publishes for it, never the apt repository's
# latest: this runs model-directed commands, and its version is part of the
# image's content hash. To move it, take both sums from that release's
# gh_<version>_checksums.txt.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum=f876a3b87bf67c94f773d17becca4dc7340b056dab901473a9260ee2a73e237b ;; \
      arm64) sum=9aec87f9a011b1521556b06cb003776e7e214144c8efd2144924a28d90c23057 ;; \
      *) echo "no pinned gh build for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_${arch}.deb"; \
    echo "$sum  /tmp/gh.deb" | sha256sum -c -; \
    dpkg -i /tmp/gh.deb; \
    rm /tmp/gh.deb

# Office/ebook text extraction for attachments (see sandbox/extract.py).
#
# Deliberately the individual format libraries rather than Microsoft's
# markitdown, which is the obvious choice and was the original plan: markitdown
# takes magika (and so onnxruntime, numpy, pandas) as a *base* dependency,
# measured at 326 MB across 30 packages versus 63 MB across 20 here — and it
# ships no extras for ODT, RTF, or EPUB, so it would have covered fewer of the
# formats while costing 5x the image. Every one of these is text-extraction
# only; none of them execute macros or embedded scripts.
RUN pip3 install --break-system-packages --no-cache-dir \
    mammoth \
    openpyxl \
    python-pptx \
    odfpy \
    striprtf \
    ebooklib \
    beautifulsoup4

COPY sandbox/extract.py /usr/local/bin/loxaic-extract
RUN chmod 0755 /usr/local/bin/loxaic-extract

RUN useradd -m -s /bin/bash loxaic
USER loxaic

# The handle's `workdir`, created here rather than on first use so it exists
# from the moment the container starts. Docker refuses an `exec` whose
# WorkingDir is missing, and since #62 every exec that names no directory is
# given this one — including the very first, which is the clone (git is happy
# to clone into an existing empty directory) or the mkdir that stands in for
# it. Creating it in the image is what makes "the default working directory"
# true unconditionally instead of after some other call has been made.
RUN mkdir -p /home/loxaic/repo
WORKDIR /home/loxaic

CMD ["bash"]
