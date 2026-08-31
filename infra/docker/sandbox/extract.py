#!/usr/bin/env python3
"""
Plain-text extraction for Office and ebook attachments.

Runs **inside the sandbox container, never on the server** — every input here
is a file the server did not author, and these are exactly the formats whose
parsers have the worst history. The container is the isolation boundary: no
network, non-root, and memory/CPU/pids limits. Keep it that way; nothing in
this file should ever be lifted into the server process.

**Extraction reads, it never executes.** No macro, embedded script, or
external reference is evaluated. `defusedxml` is not needed here because none
of these libraries expand external entities by default, but any parser added
later must be checked for that specifically.

Text only, matching what Claude does with the same formats: images embedded
in a document are not read or interpreted. A DOCX that is one big screenshot
extracts to nothing, and that is the honest answer rather than a silent
partial one.

Usage: extract.py <format> <path>
Writes UTF-8 text to stdout. Exits non-zero with a message on stderr.
"""
import sys
import zipfile

# ── Decompression-bomb guards ─────────────────────────────
# Every format below except RTF is a zip container, so an attachment that is
# small on disk can expand arbitrarily once read. The container's own memory
# limit would eventually stop that, but as an OOM kill — which surfaces as an
# opaque failure and burns the whole 60s budget first. These checks read only
# the zip's central directory (no decompression at all) and reject early with
# a reason, which is both faster and far more diagnosable.
MAX_ENTRIES = 5_000
MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024  # well under the sandbox's 512 MB
MAX_RATIO = 200  # XML compresses ~20-50x legitimately; 200 is generous

# Bound on what this script itself will print. The exec layer caps its own
# read separately; this stops a pathological-but-not-bomb document (a
# million-row sheet) from generating gigabytes before that cap applies.
MAX_OUTPUT_CHARS = 8 * 1024 * 1024
MAX_SHEET_ROWS = 50_000


def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def guard_zip(path):
    """Reject a zip bomb from its central directory, before anything inflates."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
    except zipfile.BadZipFile:
        die("not a readable zip-based document")
    except OSError as err:
        die(f"could not open the document: {err}")

    if len(infos) > MAX_ENTRIES:
        die(f"archive has {len(infos)} entries, over the {MAX_ENTRIES} limit")

    total = 0
    for info in infos:
        total += info.file_size
        if total > MAX_TOTAL_UNCOMPRESSED:
            die(f"archive expands to over {MAX_TOTAL_UNCOMPRESSED} bytes")
        # A single entry with an absurd ratio is the classic bomb shape, and
        # is worth catching even when the total would have stayed in budget.
        if info.compress_size > 0 and info.file_size / info.compress_size > MAX_RATIO:
            die(f"archive entry {info.filename!r} exceeds the {MAX_RATIO}:1 compression ratio limit")


def emit(parts):
    """Join, bound, and write. One place so every format is capped alike."""
    text = "\n".join(p for p in parts if p)
    if len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS]
    sys.stdout.write(text)


# ── Per-format extractors ─────────────────────────────────

def from_docx(path):
    import mammoth
    with open(path, "rb") as fh:
        return [mammoth.extract_raw_text(fh).value]


def from_xlsx(path):
    import openpyxl
    # read_only streams rather than building the whole workbook in memory;
    # data_only takes cached formula results instead of the formula text,
    # which is what a reader actually wants to see.
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    parts = []
    rows_seen = 0
    try:
        for sheet in book.worksheets:
            parts.append(f"# Sheet: {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                if rows_seen >= MAX_SHEET_ROWS:
                    parts.append(f"[truncated at {MAX_SHEET_ROWS} rows]")
                    return parts
                rows_seen += 1
                cells = ["" if c is None else str(c) for c in row]
                if any(cells):
                    parts.append(",".join(cells))
    finally:
        book.close()
    return parts


def from_pptx(path):
    from pptx import Presentation
    parts = []
    for i, slide in enumerate(Presentation(path).slides, 1):
        parts.append(f"# Slide {i}")
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    line = "".join(run.text for run in para.runs)
                    if line.strip():
                        parts.append(line)
    return parts


def from_odt(path):
    from odf import teletype
    from odf.opendocument import load
    from odf.text import P
    doc = load(path)
    return [teletype.extractText(p) for p in doc.getElementsByType(P)]


def from_rtf(path):
    from striprtf.striprtf import rtf_to_text
    # RTF is the one non-zip format here; it is read as text, and a decode
    # error means it was not RTF in the first place.
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return [rtf_to_text(fh.read(), errors="ignore")]


def from_epub(path):
    import ebooklib
    from bs4 import BeautifulSoup
    from ebooklib import epub
    book = epub.read_epub(path, options={"ignore_ncx": True})
    parts = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        text = soup.get_text("\n").strip()
        if text:
            parts.append(text)
    return parts


EXTRACTORS = {
    "docx": (from_docx, True),
    "xlsx": (from_xlsx, True),
    "pptx": (from_pptx, True),
    "odt": (from_odt, True),
    "epub": (from_epub, True),
    "rtf": (from_rtf, False),
}


def main():
    if len(sys.argv) != 3:
        die("usage: extract.py <format> <path>")
    fmt, path = sys.argv[1], sys.argv[2]
    if fmt not in EXTRACTORS:
        die(f"no extractor for {fmt}")
    extractor, is_zip = EXTRACTORS[fmt]
    if is_zip:
        guard_zip(path)
    try:
        emit(extractor(path))
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001 — any parser failure is just "unreadable"
        die(f"{fmt} extraction failed: {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
