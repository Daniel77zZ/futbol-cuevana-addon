"""Shared utilities: quality normalization, logging."""

import logging
import re
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("extractors")


QUALITY_PATTERNS = [
    (re.compile(r"\b(2160|4k|uhd)\b", re.I), "2160p"),
    (re.compile(r"\b(1440|2k|qhd)\b", re.I), "1440p"),
    (re.compile(r"\b(1080|full.?hd|fhd)\b", re.I), "1080p"),
    (re.compile(r"\b(720|hd)\b", re.I), "720p"),
    (re.compile(r"\b(480|sd)\b", re.I), "480p"),
    (re.compile(r"\b(360)\b", re.I), "360p"),
    (re.compile(r"\b(240)\b", re.I), "240p"),
]


def normalize_quality(raw: Optional[str]) -> str:
    """Normalize quality string to standard format (1080p, 720p, etc.)."""
    if not raw:
        return "unknown"
    raw_lower = raw.lower()
    for pattern, normalized in QUALITY_PATTERNS:
        if pattern.search(raw_lower):
            return normalized
    # Try to extract number + p
    match = re.search(r"(\d{3,4})p?", raw_lower)
    if match:
        return f"{match.group(1)}p"
    return "unknown"


def infer_quality_from_url(url: str) -> str:
    """Infer quality from URL path/query parameters."""
    return normalize_quality(url)


def setup_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Create a logger with the given name."""
    log = logging.getLogger(name)
    log.setLevel(level)
    return log