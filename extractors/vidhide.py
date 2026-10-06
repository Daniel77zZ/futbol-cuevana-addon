"""VidHide / tungtungsahur HLS extractor using Playwright with stealth."""

import asyncio
import base64
import logging
import re
from typing import Optional
from urllib.parse import urlparse

from pydantic import BaseModel, HttpUrl, Field

from .shared.http import StealthBrowser, navigate_with_retry, wait_for_selector_with_retry, click_if_exists, intercept_hls_requests
from .shared.utils import normalize_quality, infer_quality_from_url, setup_logger

logger = setup_logger("vidhide")

# XOR key for token decoding (from tungtungsahur loader)
XOR_KEY = "a45f04ce-2394-47c3-b718-0ecd97ce51d6"


class VidHideResult(BaseModel):
    """Result from VidHide extraction."""
    hls: HttpUrl
    quality: str = Field(default="1080p")
    sourceUrl: HttpUrl


async def decode_token_xor(token: str) -> str:
    """
    Decode XOR-encoded token from tungtungsahur.
    
    The token format: first char is prefix, rest is base64 encoded XOR'd data.
    XOR key: a45f04ce-2394-47c3-b718-0ecd97ce51d6
    """
    if not token or len(token) < 2:
        return token
    
    # Remove first character (prefix) and decode base64
    b64_data = token[1:]
    try:
        decoded = base64.b64decode(b64_data)
    except Exception as e:
        logger.warning("Failed to base64 decode token: %s", e)
        return token
    
    # XOR with key (cyclic)
    key_bytes = XOR_KEY.encode('utf-8')
    result = bytearray(len(decoded))
    for i, byte in enumerate(decoded):
        result[i] = byte ^ key_bytes[i % len(key_bytes)]
    
    try:
        return result.decode('utf-8')
    except Exception as e:
        logger.warning("Failed to decode XOR result: %s", e)
        return token


async def extract_vidhide_hls(embed_url: str, headless: bool = True) -> VidHideResult:
    """
    Extract HLS URL from VidHide via tungtungsahur token flow.
    
    Args:
        embed_url: Token embed URL like https://tungtungsahur.cuevana3k.pro/?token=1D0VEA0dMAQ1AVVdW
        headless: Run browser in headless mode
    
    Returns:
        VidHideResult with hls URL, quality, and source URL
    """
    browser = StealthBrowser(headless=headless)
    hls_url: Optional[str] = None
    final_url = embed_url
    
    try:
        await browser.start()
        
        async with browser.new_page() as page:
            # Intercept ALL requests to find HLS URLs (VidHide m3u8 URLs don't always contain .m3u8)
            intercepted = await intercept_hls_requests(page, "token=")
            
            # Navigate to tungtungsahur token URL
            await navigate_with_retry(page, embed_url)
            
            # Wait for redirect to VidHide iframe
            # The loader JS will decode token and redirect
            await asyncio.sleep(3)
            
            # Check if we're on VidHide domain
            current_url = page.url
            logger.info("Current URL after redirect: %s", current_url)
            
            # Look for VidHide iframe
            vidhide_frame = None
            for frame in page.frames:
                frame_url = frame.url
                if any(domain in frame_url for domain in ["vidhide", "lkhjerbhye", "lol/v/"]):
                    vidhide_frame = frame
                    logger.info("Found VidHide iframe: %s", frame_url)
                    break
            
            # If not in iframe, check main page
            if not vidhide_frame:
                if any(domain in current_url for domain in ["vidhide", "lkhjerbhye", "lol/v/"]):
                    vidhide_frame = page.main_frame
                    logger.info("On VidHide page directly: %s", current_url)
            
            if vidhide_frame:
                final_url = vidhide_frame.url
                
                # Wait for JWPlayer to load and request HLS
                await asyncio.sleep(5)
                
# Check intercepted URLs
            if intercepted:
                # Filter for valid VidHide HLS URLs - look for token= and m3u8-like patterns
                for url in intercepted:
                    if "token=" in url and (".m3u8" in url or "m3u8" in url or "master" in url or "/v/" in url):
                        hls_url = url
                        logger.info("Using intercepted HLS URL: %s", hls_url)
                        break
            
            # Fallback: try to extract from page/frame evaluation
            if not hls_url and vidhide_frame:
                hls_url = await _extract_hls_from_vidhide(vidhide_frame)
            
            # Final fallback: check all frames
            if not hls_url:
                for frame in page.frames:
                    try:
                        frame_hls = await frame.evaluate(
                            """() => {
                                // Check video elements
                                const videos = document.querySelectorAll('video');
                                for (const v of videos) {
                                    if (v.src && v.src.includes('token=') && (v.src.includes('.m3u8') || v.src.includes('m3u8') || v.src.includes('master') || v.src.includes('playlist'))) {
                                        return v.src;
                                    }
                                    const sources = v.querySelectorAll('source');
                                    for (const s of sources) {
                                        if (s.src && s.src.includes('token=') && (s.src.includes('.m3u8') || s.src.includes('m3u8') || s.src.includes('master') || s.src.includes('playlist'))) {
                                            return s.src;
                                        }
                                    }
                                }
                                // Check JWPlayer
                                if (window.jwplayer) {
                                    const player = window.jwplayer();
                                    if (player && player.getPlaylist) {
                                        const playlist = player.getPlaylist();
                                        for (const item of playlist) {
                                            if (item.sources) {
                                                for (const src of item.sources) {
                                                    if (src.file && src.file.includes('token=') && (src.file.includes('.m3u8') || src.file.includes('m3u8') || src.file.includes('master') || src.file.includes('playlist'))) {
                                                        return src.file;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                // Check for hls.js
                                if (window.hlsjsPlayers) {
                                    for (const p of window.hlsjsPlayers) {
                                        if (p.url && p.url.includes('token=') && (p.url.includes('.m3u8') || p.url.includes('m3u8') || p.url.includes('master') || p.url.includes('playlist'))) {
                                            return p.url;
                                        }
                                    }
                                }
                                // Search scripts for m3u8 URLs
                                const scripts = document.querySelectorAll('script');
                                for (const s of scripts) {
                                    const text = s.textContent || s.innerText || '';
                                    // Match m3u8 URLs with token=, also match master.m3u8, playlist.m3u8, etc.
                                    const matches = text.match(/https?:\/\/[^"']+(?:\.m3u8|master\.m3u8|playlist\.m3u8|master\.txt)\?token=[^"']/g);
                                    if (matches) return matches[0];
                                    // Also match URLs with token= that look like HLS endpoints
                                    const matches2 = text.match(/https?:\/\/[^"']+\?token=[^"']/g);
                                    if (matches2) {
                                        for (const m of matches2) {
                                            if (m.includes('m3u8') || m.includes('master') || m.includes('playlist') || m.includes('/v/')) {
                                                return m;
                                            }
                                        }
                                    }
                                }
                                return null;
                            }"""
                        )
                        if frame_hls:
                            hls_url = frame_hls
                            logger.info("Extracted HLS from frame evaluation: %s", hls_url)
                            break
                    except Exception as e:
                        logger.debug("Frame evaluation failed: %s", e)
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
        quality = "1080p"  # Default for VidHide
    
    return VidHideResult(
        hls=hls_url,
        quality=quality,
        sourceUrl=final_url,
    )


async def _extract_hls_from_vidhide(frame) -> Optional[str]:
    """Try to extract HLS URL from VidHide page/frame JavaScript."""
    try:
        result = await frame.evaluate(
            """() => {
                // Check video elements
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.src && v.src.includes('token=') && (v.src.includes('.m3u8') || v.src.includes('m3u8') || v.src.includes('master') || v.src.includes('playlist'))) {
                        return v.src;
                    }
                    const sources = v.querySelectorAll('source');
                    for (const s of sources) {
                        if (s.src && s.src.includes('token=') && (s.src.includes('.m3u8') || s.src.includes('m3u8') || s.src.includes('master') || s.src.includes('playlist'))) {
                            return s.src;
                        }
                    }
                }
                // Check JWPlayer
                if (window.jwplayer) {
                    const player = window.jwplayer();
                    if (player && player.getPlaylist) {
                        const playlist = player.getPlaylist();
                        for (const item of playlist) {
                            if (item.sources) {
                                for (const src of item.sources) {
                                    if (src.file && src.file.includes('token=') && (src.file.includes('.m3u8') || src.file.includes('m3u8') || src.file.includes('master') || src.file.includes('playlist'))) {
                                        return src.file;
                                    }
                                }
                            }
                        }
                    }
                }
                // Check for hls.js players
                if (window.hlsjsPlayers) {
                    for (const p of window.hlsjsPlayers) {
                        if (p.url && p.url.includes('token=') && (p.url.includes('.m3u8') || p.url.includes('m3u8') || p.url.includes('master') || p.url.includes('playlist'))) {
                            return p.url;
                        }
                    }
                }
// Search scripts for m3u8 URLs
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || s.innerText || '';
                    // Match m3u8 URLs with token=, also match master.m3u8, playlist.m3u8, etc.
                    const matches = text.match(/https?:\/\/[^"']+(?:\.m3u8|master\.m3u8|playlist\.m3u8|master\.txt)\?token=[^"']/g);
                    if (matches) return matches[0];
                    // Also match URLs with token= that look like HLS endpoints
                    const matches2 = text.match(/https?:\/\/[^"']+\?token=[^"']/g);
                    if (matches2) {
                        for (const m of matches2) {
                            if (m.includes('m3u8') || m.includes('master') || m.includes('playlist') || m.includes('/v/')) {
                                return m;
                            }
                        }
                    }
                }
                return null;
            }"""
        )
        return result
    except Exception as e:
        logger.debug("VidHide page evaluation failed: %s", e)
        return None


def extract_vidhide_sync(embed_url: str, headless: bool = True) -> VidHideResult:
    """Synchronous wrapper for extract_vidhide_hls."""
    return asyncio.run(extract_vidhide_hls(embed_url, headless))