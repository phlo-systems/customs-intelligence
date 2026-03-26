"""
embedding_loader.py — Download HS descriptions + compute embeddings + load to Supabase.

Sources:
    1. UN Comtrade H6 (HS 2022) — 5,613 international 6-digit subheadings
    2. GitHub datasets/harmonized-system — sections, chapters, headings for context
    3. Existing COMMODITY_CODE table — national descriptions (ZA, NA, GB, etc.)

Embedding model: OpenAI text-embedding-3-small (1536 dimensions)
    - ~$0.02 per 1M tokens
    - ~6,000 descriptions ≈ 200K tokens ≈ $0.004

Usage:
    python -m tariff_parser.embedding_loader
    python -m tariff_parser.embedding_loader --source comtrade     # HS international only
    python -m tariff_parser.embedding_loader --source national     # DB national descriptions only
    python -m tariff_parser.embedding_loader --source all          # both (default)

Environment variables required:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
    OPENAI_API_KEY
"""

import argparse
import json
import logging
import os
import sys
import time
from typing import Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("embedding_loader")

COMTRADE_URL = "https://comtradeapi.un.org/files/v1/app/reference/H6.json"
GITHUB_HS_URL = "https://raw.githubusercontent.com/datasets/harmonized-system/main/data/harmonized-system.csv"
GITHUB_SECTIONS_URL = "https://raw.githubusercontent.com/datasets/harmonized-system/main/data/sections.csv"

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
BATCH_SIZE = 100  # OpenAI allows up to 2048 inputs per batch


# ── Data fetchers ────────────────────────────────────────────────────────────

def fetch_comtrade_hs() -> list[dict]:
    """
    Fetch HS 2022 codes from UN Comtrade.
    Returns list of {code, description, level, parent} dicts.
    """
    logger.info("Fetching UN Comtrade H6 (HS 2022)...")
    resp = requests.get(COMTRADE_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    results = data.get("results", [])
    logger.info("Comtrade: %d entries", len(results))

    codes = []
    for entry in results:
        text = entry.get("text", "")
        entry_id = str(entry.get("id", ""))

        # text format: "200410 - Potatoes, prepared or preserved..."
        # or "20 - Preparations of vegetables..."
        parts = text.split(" - ", 1)
        if len(parts) != 2:
            continue

        code = parts[0].strip()
        description = parts[1].strip()

        # Determine level from code length
        if len(code) == 2:
            level = "chapter"
        elif len(code) == 4:
            level = "heading"
        elif len(code) == 6:
            level = "subheading"
        else:
            continue

        codes.append({
            "code": code,
            "description": description,
            "level": level,
            "parent": str(entry.get("parent", "")),
        })

    chapters = len([c for c in codes if c["level"] == "chapter"])
    headings = len([c for c in codes if c["level"] == "heading"])
    subheadings = len([c for c in codes if c["level"] == "subheading"])
    logger.info("Parsed: %d chapters, %d headings, %d subheadings", chapters, headings, subheadings)

    return codes


def fetch_national_descriptions(supabase_url: str, supabase_key: str) -> list[dict]:
    """
    Fetch national commodity descriptions from existing COMMODITY_CODE table.
    Returns list of {code, description, country_code} dicts.
    """
    logger.info("Fetching national descriptions from COMMODITY_CODE table...")
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    all_rows = []
    offset = 0
    page_size = 1000

    while True:
        resp = requests.get(
            f"{supabase_url}/rest/v1/commodity_code",
            headers=headers,
            params={
                "select": "commoditycode,subheadingcode,nationaldescription,countrycode",
                "isactive": "eq.true",
                "offset": offset,
                "limit": page_size,
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            break
        all_rows.extend(rows)
        offset += page_size
        if len(rows) < page_size:
            break

    logger.info("Fetched %d national descriptions", len(all_rows))
    return all_rows


# ── Description enrichment ───────────────────────────────────────────────────

def build_enriched_descriptions(comtrade_codes: list[dict]) -> list[dict]:
    """
    Build enriched description texts for 6-digit subheadings by concatenating
    the chapter + heading + subheading descriptions for better embedding quality.

    Example: "Chapter 20: Preparations of vegetables, fruit, nuts or other parts
    of plants > Heading 2004: Other vegetables prepared or preserved otherwise
    than by vinegar or acetic acid, frozen > 200410: Potatoes"
    """
    # Build lookup maps
    chapter_map = {}
    heading_map = {}
    subheading_list = []

    for c in comtrade_codes:
        if c["level"] == "chapter":
            chapter_map[c["code"]] = c["description"]
        elif c["level"] == "heading":
            heading_map[c["code"]] = c["description"]
        elif c["level"] == "subheading":
            subheading_list.append(c)

    enriched = []
    for sub in subheading_list:
        code = sub["code"]
        chapter_code = code[:2]
        heading_code = code[:4]

        chapter_desc = chapter_map.get(chapter_code, "")
        heading_desc = heading_map.get(heading_code, "")
        sub_desc = sub["description"]

        # Build rich description for better embedding
        parts = []
        if chapter_desc:
            parts.append(f"Chapter {chapter_code}: {chapter_desc}")
        if heading_desc:
            parts.append(f"Heading {heading_code}: {heading_desc}")
        parts.append(f"{code}: {sub_desc}")

        enriched_text = " > ".join(parts)

        enriched.append({
            "subheading_code": code,
            "description_text": enriched_text,
            "country_code": "XX",  # XX = international / WCO standard
            "hs_version": "HS 2022",
        })

    logger.info("Built %d enriched international descriptions", len(enriched))
    return enriched


def build_national_descriptions(national_rows: list[dict]) -> list[dict]:
    """
    Build embedding records from national commodity descriptions.
    Groups by subheading — takes the longest description per (subheading, country).
    """
    # Group by (subheading, country) — keep longest description
    best: dict[tuple[str, str], dict] = {}

    for row in national_rows:
        code = row.get("subheadingcode", "")
        country = row.get("countrycode", "")
        desc = row.get("nationaldescription", "")

        if not code or not desc or len(code) < 6:
            continue

        key = (code[:6], country)
        if key not in best or len(desc) > len(best[key]["description_text"]):
            best[key] = {
                "subheading_code": code[:6],
                "description_text": desc,
                "country_code": country,
                "hs_version": "HS 2022",
            }

    records = list(best.values())
    logger.info("Built %d national description records", len(records))
    return records


# ── Embedding computation ────────────────────────────────────────────────────

def compute_embeddings(texts: list[str], openai_key: str) -> list[list[float]]:
    """
    Compute embeddings using OpenAI text-embedding-3-small.
    Processes in batches of BATCH_SIZE.
    """
    all_embeddings: list[list[float]] = []
    headers = {
        "Authorization": f"Bearer {openai_key}",
        "Content-Type": "application/json",
    }

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        logger.info("Computing embeddings: batch %d-%d of %d",
                     i + 1, min(i + BATCH_SIZE, len(texts)), len(texts))

        resp = requests.post(
            "https://api.openai.com/v1/embeddings",
            headers=headers,
            json={
                "model": EMBEDDING_MODEL,
                "input": batch,
                "dimensions": EMBEDDING_DIM,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()

        # Sort by index to preserve order
        sorted_data = sorted(data["data"], key=lambda x: x["index"])
        batch_embeddings = [item["embedding"] for item in sorted_data]
        all_embeddings.extend(batch_embeddings)

        # Brief pause between batches
        if i + BATCH_SIZE < len(texts):
            time.sleep(0.5)

    logger.info("Computed %d embeddings (dim=%d)", len(all_embeddings), EMBEDDING_DIM)
    return all_embeddings


# ── Supabase writer ──────────────────────────────────────────────────────────

def write_embeddings(
    records: list[dict],
    embeddings: list[list[float]],
    supabase_url: str,
    supabase_key: str,
    batch_size: int = 50,
) -> dict:
    """
    Write embedding records to HS_DESCRIPTION_EMBEDDING table.
    """
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    stats = {"written": 0, "errors": 0}

    rows = []
    for record, embedding in zip(records, embeddings):
        rows.append({
            "subheadingcode": record["subheading_code"],
            "hsversion": record["hs_version"],
            "countrycode": record["country_code"],
            "descriptiontext": record["description_text"][:2000],
            "embedding": embedding,
            "embeddingmodel": EMBEDDING_MODEL,
        })

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        try:
            resp = requests.post(
                f"{supabase_url}/rest/v1/hs_description_embedding",
                headers=headers,
                json=batch,
                timeout=60,
            )
            if resp.status_code in (200, 201):
                stats["written"] += len(batch)
            else:
                logger.error("Upsert failed: %s — %s", resp.status_code, resp.text[:200])
                stats["errors"] += len(batch)
        except requests.RequestException as exc:
            logger.error("Upsert error: %s", exc)
            stats["errors"] += len(batch)

        if (i + batch_size) % 200 == 0:
            logger.info("Write progress: %d / %d", i + batch_size, len(rows))

    logger.info("Write complete: %d written, %d errors", stats["written"], stats["errors"])
    return stats


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="HS description embedding loader")
    parser.add_argument(
        "--source",
        default="all",
        choices=["comtrade", "national", "all"],
        help="Which descriptions to embed (default: all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and compute but don't write to DB",
    )
    args = parser.parse_args()

    # Validate env
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")

    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)
    if not openai_key:
        logger.error("Missing OPENAI_API_KEY")
        sys.exit(1)

    all_records: list[dict] = []

    # ── Fetch international HS descriptions ──
    if args.source in ("comtrade", "all"):
        comtrade_codes = fetch_comtrade_hs()
        international = build_enriched_descriptions(comtrade_codes)
        all_records.extend(international)

    # ── Fetch national descriptions from DB ──
    if args.source in ("national", "all"):
        national_rows = fetch_national_descriptions(supabase_url, supabase_key)
        national = build_national_descriptions(national_rows)
        all_records.extend(national)

    if not all_records:
        logger.warning("No records to embed")
        sys.exit(0)

    logger.info("Total records to embed: %d", len(all_records))

    # ── Compute embeddings ──
    texts = [r["description_text"] for r in all_records]
    embeddings = compute_embeddings(texts, openai_key)

    if len(embeddings) != len(all_records):
        logger.error("Embedding count mismatch: %d records vs %d embeddings",
                      len(all_records), len(embeddings))
        sys.exit(1)

    # ── Write to Supabase ──
    if args.dry_run:
        logger.info("[dry-run] Would write %d embedding rows", len(all_records))
        for r in all_records[:5]:
            logger.info("  %s (%s) — %s", r["subheading_code"], r["country_code"],
                        r["description_text"][:80])
        return

    stats = write_embeddings(all_records, embeddings, supabase_url, supabase_key)
    logger.info("Done: %d written, %d errors", stats["written"], stats["errors"])


if __name__ == "__main__":
    main()
