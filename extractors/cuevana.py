"""Cuevana hosts extractor using yt-dlp subprocess."""

import asyncio
import json
import logging
import re
import subprocess
from typing import Optional, List
from urllib.parse import urlparse

from pydantic import BaseModel, HttpUrl, Field

from shared.utils import normalize_quality, infer_quality_from_url, setup_logger

logger = setup_logger("cuevana")


class CuevanaResult(BaseModel):
    """Result from cuevana host extraction."""
    hls: HttpUrl
    quality: str = Field(default="1080p")
    sourceUrl: HttpUrl


# Host priority order (highest first)
HOST_PRIORITY = [
    "fembed",
    "gounlimited",
    "streamtape",
    "doodstream",
    "vidoza",
    "upstream",
    "filemoon",
    "streamlare",
    "voe",
    "streamwish",
    "streamhub",
    "filelions",
    "megacloud",
    "vidmoly",
    "vidhide",
    "vidguard",
    "vidfast",
    "vidhidevip",
    "vidplay",
    "vidcloud",
    "vidlink",
    "vidstream",
    "vidxyz",
]


def get_host_priority(url: str) -> int:
    """Get priority index for a host (lower = higher priority)."""
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    for i, host in enumerate(HOST_PRIORITY):
        if host in domain:
            return i
    return len(HOST_PRIORITY)  # Unknown hosts go last


async def extract_cuevana_hls(embed_url: str) -> CuevanaResult:
    """
    Extract HLS URL from cuevana host using yt-dlp.

    Args:
        embed_url: Embed URL from cuevana3k.pro like https://fembed.net/v/abc123

    Returns:
        CuevanaResult with hls URL, quality, and source URL
    """
    logger.info("Extracting HLS from cuevana host: %s", embed_url)

    # Run yt-dlp to get direct URLs
    cmd = [
        "yt-dlp",
        "-g",  # Get URLs only
        "--no-check-certificate",
        "--no-warnings",
        "--skip-download",
        embed_url,
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)

        if process.returncode != 0:
            error_msg = stderr.decode().strip()
            logger.error("yt-dlp failed: %s", error_msg)
            raise RuntimeError(f"yt-dlp failed: {error_msg}")

        output = stdout.decode().strip()
        logger.debug("yt-dlp output: %s", output)

        # Parse output - yt-dlp outputs one URL per line
        urls = [line.strip() for line in output.split("\n") if line.strip()]

        # Filter for HLS URLs
        hls_urls = [u for u in urls if ".m3u8" in u]

        if not hls_urls:
            # Try to get any valid URL and check if it's a manifest
            raise RuntimeError(f"No HLS (.m3u8) URL found in yt-dlp output for {embed_url}")

        # Sort by host priority
        hls_urls.sort(key=get_host_priority)

        # Get the best quality URL
        best_url = await _select_best_quality(hls_urls)

        quality = infer_quality_from_url(best_url)
        if quality == "unknown":
            quality = "1080p"

        return CuevanaResult(
            hls=best_url,
            quality=quality,
            sourceUrl=embed_url,
        )

    except asyncio.TimeoutError:
        raise RuntimeError(f"yt-dlp timed out for {embed_url}")
    except FileNotFoundError:
        raise RuntimeError("yt-dlp not found. Please install yt-dlp.")
    except Exception as e:
        logger.error("Extraction failed: %s", e)
        raise


async def _select_best_quality(hls_urls: List[str]) -> str:
    """Select the best quality HLS URL from the list."""
    # yt-dlp usually returns the best quality first, but let's verify
    # by checking for quality indicators in URL
    quality_scores = {}
    for url in hls_urls:
        quality = infer_quality_from_url(url)
        score = _quality_to_score(quality)
        quality_scores[url] = score
        logger.debug("URL: %s -> Quality: %s (score: %d)", url, quality, score)

    # Return highest scored URL
    best_url = max(quality_scores, key=quality_scores.get)
    logger.info("Selected best quality URL: %s (quality: %s)",
                best_url, infer_quality_from_url(best_url))
    return best_url


def _quality_to_score(quality: str) -> int:
    """Convert quality string to numeric score."""
    quality_map = {
        "2160p": 2160,
        "1440p": 1440,
        "1080p": 1080,
        "720p": 720,
        "480p": 480,
        "360p": 360,
        "240p": 240,
        "unknown": 0,
    }
    return quality_map.get(quality, 0)


def extract_cuevana_sync(embed_url: str) -> CuevanaResult:
    """Synchronous wrapper for extract_cuevana_hls."""
    return asyncio.run(extract_cuevana_hls(embed_url))