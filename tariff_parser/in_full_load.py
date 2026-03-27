"""
in_full_load.py — Load all India commodity codes from Customs Tariff Act PDFs.

Parses chapter PDFs (chap-1.pdf through chap-97.pdf) and writes
parsed tariff data to Supabase. Optionally uploads PDFs to Supabase Storage.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads
    python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --chapters 1 28 72
    python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --resume-from 44
    python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --dry-run
    python3 -m tariff_parser.in_full_load --pdf-dir ~/Downloads --upload-pdfs
"""

import argparse
import glob
import logging
import os
import sys
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("in_full_load")


def discover_chapter_pdfs(pdf_dir: str) -> list[tuple[int, str]]:
    """Find all chap-N.pdf files and return sorted list of (chapter_num, path)."""
    pattern = os.path.join(pdf_dir, "chap-*.pdf")
    files = glob.glob(pattern)

    chapters = []
    for f in files:
        basename = os.path.basename(f)
        try:
            num = int(basename.replace("chap-", "").replace(".pdf", ""))
            chapters.append((num, f))
        except ValueError:
            logger.warning("Skipping non-numeric PDF: %s", basename)

    chapters.sort(key=lambda x: x[0])
    logger.info("Found %d chapter PDFs in %s", len(chapters), pdf_dir)
    return chapters


def upload_pdf_to_storage(
    pdf_path: str,
    chapter_num: int,
    supabase_url: str,
    supabase_key: str,
    bucket: str = "tariff-docs",
) -> bool:
    """Upload a single PDF to Supabase Storage."""
    filename = f"IN/chapter-{chapter_num:02d}.pdf"
    url = f"{supabase_url}/storage/v1/object/{bucket}/{filename}"

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/pdf",
        "x-upsert": "true",
    }

    try:
        with open(pdf_path, "rb") as f:
            resp = requests.post(url, headers=headers, data=f, timeout=60)

        if resp.status_code in (200, 201):
            logger.info("Uploaded %s → %s", os.path.basename(pdf_path), filename)
            return True
        else:
            logger.error(
                "Upload failed for %s: %s — %s",
                filename, resp.status_code, resp.text[:200],
            )
            return False
    except Exception as exc:
        logger.error("Upload error for %s: %s", filename, exc)
        return False


def ensure_storage_bucket(supabase_url: str, supabase_key: str, bucket: str = "tariff-docs"):
    """Create the storage bucket if it doesn't exist."""
    url = f"{supabase_url}/storage/v1/bucket"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
    }

    # Check if bucket exists
    resp = requests.get(f"{url}/{bucket}", headers=headers, timeout=15)
    if resp.status_code == 200:
        logger.info("Storage bucket '%s' exists", bucket)
        return

    # Create bucket
    resp = requests.post(
        url,
        headers=headers,
        json={"id": bucket, "name": bucket, "public": False},
        timeout=15,
    )
    if resp.status_code in (200, 201):
        logger.info("Created storage bucket '%s'", bucket)
    else:
        logger.warning("Bucket creation response: %s — %s", resp.status_code, resp.text[:200])


def main():
    parser = argparse.ArgumentParser(description="Full India tariff load from PDFs")
    parser.add_argument("--pdf-dir", required=True, help="Directory containing chap-N.pdf files")
    parser.add_argument("--chapters", nargs="+", type=int, help="Specific chapters to load")
    parser.add_argument("--resume-from", type=int, help="Resume from this chapter number")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    parser.add_argument("--upload-pdfs", action="store_true", help="Upload PDFs to Supabase Storage")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    from tariff_parser.parsers.in_parser import INParser
    from tariff_parser.writers.db_writer import SupabaseWriter

    in_parser = INParser()
    writer = SupabaseWriter(supabase_url, supabase_key)

    # Discover PDFs
    all_chapters = discover_chapter_pdfs(args.pdf_dir)

    if args.chapters:
        chapters = [(n, p) for n, p in all_chapters if n in args.chapters]
    else:
        chapters = all_chapters

    if args.resume_from:
        chapters = [(n, p) for n, p in chapters if n >= args.resume_from]
        logger.info("Resuming from chapter %d (%d chapters remaining)", args.resume_from, len(chapters))

    if not chapters:
        logger.error("No chapter PDFs found")
        sys.exit(1)

    # Ensure storage bucket exists if uploading
    if args.upload_pdfs and not args.dry_run:
        ensure_storage_bucket(supabase_url, supabase_key)

    total_commodities = 0
    total_written = 0
    total_uploaded = 0
    errors = []
    start = datetime.now(timezone.utc)

    for i, (ch_num, pdf_path) in enumerate(chapters):
        ch_start = time.time()

        try:
            commodities = in_parser.parse_chapter_pdf(pdf_path)
            total_commodities += len(commodities)
        except Exception as exc:
            logger.error("[%02d/%02d] Chapter %d: PARSE ERROR — %s", i + 1, len(chapters), ch_num, exc)
            errors.append((ch_num, str(exc)))
            continue

        ch_time = time.time() - ch_start

        if args.dry_run:
            none_rates = sum(1 for c in commodities if c.standard_rate_pct is None)
            logger.info(
                "[%02d/%02d] Chapter %d: %d commodities (%.1fs) [dry-run] missing_rates=%d",
                i + 1, len(chapters), ch_num, len(commodities), ch_time, none_rates,
            )
            continue

        # Write to DB
        if commodities:
            try:
                stats = writer.write_in_rows(commodities)
                total_written += stats.get("inserted", 0)
            except Exception as exc:
                logger.error("[%02d/%02d] Chapter %d: DB WRITE ERROR — %s", i + 1, len(chapters), ch_num, exc)
                errors.append((ch_num, f"DB: {exc}"))
                continue

        # Upload PDF to storage
        if args.upload_pdfs:
            if upload_pdf_to_storage(pdf_path, ch_num, supabase_url, supabase_key):
                total_uploaded += 1

        logger.info(
            "[%02d/%02d] Chapter %d: %d commodities → DB (%.1fs) | Running total: %d",
            i + 1, len(chapters), ch_num, len(commodities), ch_time, total_commodities,
        )

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    logger.info("=" * 60)
    logger.info("India full load complete")
    logger.info("  Chapters processed: %d", len(chapters))
    logger.info("  Commodities parsed:  %d", total_commodities)
    logger.info("  Rows written to DB:  %d", total_written)
    if args.upload_pdfs:
        logger.info("  PDFs uploaded:       %d", total_uploaded)
    logger.info("  Errors:              %d", len(errors))
    logger.info("  Time: %.0f seconds (%.1f minutes)", elapsed, elapsed / 60)

    if errors:
        logger.info("  Failed chapters: %s", [e[0] for e in errors])


if __name__ == "__main__":
    main()
