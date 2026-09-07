FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential ca-certificates \
    poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get install -y python3 python3-pip python3-venv \
    && pip3 install --break-system-packages ripgrep \
    && rm -rf /var/lib/apt/lists/*

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
