"""tvf90.com / fubo18.com HLS extractor using Playwright with stealth."""

import asyncio
import logging
import re
from typing import Optional
from urllib.parse import urlparse

from pydantic import BaseModel, HttpUrl, Field

from shared.http import StealthBrowser, navigate_with_retry, wait_for_selector_with_retry, click_if_exists, intercept_hls_requests
from shared.utils import normalize_quality, infer_quality_from_url, setup_logger

logger = setup_logger("tvf90")


class TVF90Result(BaseModel):
    """Result from tvf90 extraction."""
    hls: HttpUrl
    quality: str = Field(default="1080p")
    sourceUrl: HttpUrl


async def extract_tvf90_hls(embed_url: str, headless: bool = True) -> TVF90Result:
    """
    Extract HLS URL from tvf90.com/fubo18.com embed page.

    Args:
        embed_url: Embed URL like https://tvf90.com/1.php?stream=sportv
        headless: Run browser in headless mode

    Returns:
        TVF90Result with hls URL, quality, and source URL
    """
    browser = StealthBrowser(headless=headless)
    hls_url: Optional[str] = None

    try:
        await browser.start()

        async with browser.new_page() as page:
            # Intercept HLS requests before navigation
            intercepted = await intercept_hls_requests(page, "fubo18.com")

            # Navigate to embed URL
            await navigate_with_retry(page, embed_url)

            # Click first-click-ad overlay if exists
            await click_if_exists(page, "#first-click-ad")
            await click_if_exists(page, ".first-click-ad")
            await click_if_exists(page, "[id*='first-click']")
            await asyncio.sleep(1)  # Allow any redirects

            # Wait for player iframe
            try:
                await wait_for_selector_with_retry(page, "#player-frame", timeout=15000)
                logger.info("Found #player-frame iframe")
            except Exception:
                # Try alternative selectors
                for selector in ["iframe#player-frame", "iframe[id*='player']", "iframe"]:
                    try:
                        await wait_for_selector_with_retry(page, selector, timeout=5000)
                        logger.info("Found iframe with selector: %s", selector)
                        break
                    except Exception:
                        continue

            # Switch to iframe context
            frame = None
            for frame_candidate in page.frames:
                if "player" in frame_candidate.url or "fubo18" in frame_candidate.url:
                    frame = frame_candidate
                    break

            if frame:
                logger.info("Switched to iframe: %s", frame.url)
                # Wait a bit for HLS to load in iframe
                await asyncio.sleep(3)

            # Check intercepted URLs
            if intercepted:
                hls_url = intercepted[0]
                logger.info("Using intercepted HLS URL: %s", hls_url)

            # Fallback: try to get from page evaluation
            if not hls_url:
                hls_url = await _extract_hls_from_page(page)

            # Final fallback: check all frames
            if not hls_url:
                for frame_candidate in page.frames:
                    try:
                        frame_hls = await frame_candidate.evaluate(
                            """() => {
                                const videos = document.querySelectorAll('video');
                                for (const v of videos) {
                                    if (v.src && v.src.includes('.m3u8')) return v.src;
                                }
                                return null;
                            }"""
                        )
                        if frame_hls and "fubo18.com" in frame_hls and "token=" in frame_hls:
                            hls_url = frame_hls
                            break
                    except Exception:
                        continue

    finally:
        await browser.stop()

    if not hls_url:
        raise RuntimeError(f"Failed to extract HLS URL from {embed_url}")

    # Validate HLS URL
    parsed = urlparse(hls_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid HLS URL extracted: {hls_url}")

    # Determine quality
    quality = infer_quality_from_url(hls_url)
    if quality == "unknown":
        quality = "1080p"  # Default for tvf90

    return TVF90Result(
        hls=hls_url,
        quality=quality,
        sourceUrl=embed_url,
    )


async def _extract_hls_from_page(page) -> Optional[str]:
    """Try to extract HLS URL from page JavaScript."""
    try:
        # Try to find video element with HLS source
        result = await page.evaluate(
            """() => {
                // Check video elements
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.src && v.src.includes('.m3u8') && v.src.includes('token=')) {
                        return v.src;
                    }
                    // Check source children
                    const sources = v.querySelectorAll('source');
                    for (const s of sources) {
                        if (s.src && s.src.includes('.m3u8') && s.src.includes('token=')) {
                            return s.src;
                        }
                    }
                }
                // Check for hls.js players
                if (window.hlsjsPlayers) {
                    for (const p of window.hlsjsPlayers) {
                        if (p.url && p.url.includes('.m3u8') && p.url.includes('token=')) {
                            return p.url;
                        }
                    }
                }
                // Check for any m3u8 in network
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || s.innerText || '';
                    const matches = text.match(/https?:\\/\\/[^"']+\\.m3u8\\?token=[^"']/g);
                    if (matches) return matches[0];
                }
                return null;
            }"""
        )
        return result
    except Exception as e:
        logger.debug("Page evaluation failed: %s", e)
        return None


def extract_tvf90_sync(embed_url: str, headless: bool = True) -> TVF90Result:
    """Synchronous wrapper for extract_tvf90_hls."""
    return asyncio.run(extract_tvf90_hls(embed_url, headless))