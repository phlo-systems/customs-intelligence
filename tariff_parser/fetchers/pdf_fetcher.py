"""
pdf_fetcher.py — Downloads a PDF and compares SHA-256 hash against stored value.
Returns (bytes, hash, changed: bool).
"""

import hashlib
import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)


class PDFFetcher:
    """
    Fetches a PDF from a URL. Compares SHA-256 hash against last known value.
    If unchanged, returns (None, hash, False) — caller skips parsing.
    If changed (or no previous hash), returns (bytes, new_hash, True).
    """

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; PhloCustomsIntelligence/1.0; "
            "+https://phlo.io)"
        )
    }

    def __init__(self, timeout: int = 120, retry_count: int = 3):
        self.timeout = timeout
        self.retry_count = retry_count

    def fetch(
        self,
        url: str,
        last_hash: Optional[str] = None,
    ) -> tuple[Optional[bytes], str, bool]:
        """
        Download PDF and check if content has changed.

        Returns:
            (pdf_bytes, new_hash, changed)
            pdf_bytes is None if content unchanged (hash matched).
        """
        pdf_bytes = self._download_with_retry(url)
        new_hash = hashlib.sha256(pdf_bytes).hexdigest()

        if last_hash and last_hash == new_hash:
            logger.info("Hash unchanged (%s...) — skipping parse", new_hash[:12])
            return None, new_hash, False

        logger.info(
            "Hash changed: %s... → %s... (%s bytes)",
            (last_hash or "none")[:12],
            new_hash[:12],
            f"{len(pdf_bytes):,}",
        )
        return pdf_bytes, new_hash, True

    def _download_with_retry(self, url: str) -> bytes:
        last_exc = None
        for attempt in range(1, self.retry_count + 1):
            try:
                logger.info("Downloading %s (attempt %d)", url, attempt)
                resp = requests.get(
                    url,
                    headers=self.HEADERS,
                    timeout=self.timeout,
                    stream=True,
                )
                resp.raise_for_status()
                data = resp.content
                logger.info("Downloaded %s bytes", f"{len(data):,}")
                return data
            except requests.RequestException as exc:
                last_exc = exc
                logger.warning("Attempt %d failed: %s", attempt, exc)
                if attempt < self.retry_count:
                    time.sleep(2 ** attempt)

        raise RuntimeError(
            f"Failed to download {url} after {self.retry_count} attempts"
        ) from last_exc
