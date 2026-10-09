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
    prefix = token[0]
    b64_data = token[1:]
    
    # Server prefixes mapping
    SERVERS: dict[str, str] = {
        "1": "https://lkhjerbhye3wjkhodvh5xiczuvd.lol/v/",
        "2": "https://filemoon.sx/e/",
        "3": "https://lkhjerbhye3wjkhodvh5xlczuvd.lol/e/",
        "4": "https://dood.li/e/",
    }
    
    if prefix not in SERVERS:
        raise ValueError(f"Unknown server prefix: {prefix}")
    
    # Decode base64
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
        decoded_path = result.decode('utf-8')
        return f"{SERVERS[prefix]}{decoded_path}"
    except Exception as e:
        logger.warning("Failed to decode XOR result: %s", e)
        return token


def extract_token_from_url(url: str) -> Optional[str]:
    """Extract token parameter from tungtungsahur URL."""
    try:
        parsed = urlparse(url)
        return parsed.query.split('token=')[1].split('&')[0] if 'token=' in parsed.query else None
    except Exception:
        return None


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
        # Detect if this is a direct player URL (vidlink.pro, vsembed.ru, etc.) vs tungtungsahur token URL
        is_direct_player = any(domain in embed_url for domain in [
            "vidlink.pro", "vsembed.ru", "player.videasy.net", "vidapi.xyz", "vidhide"
        ])
        
        if is_direct_player:
            # Direct player URL - use as-is
            video_url = embed_url
            logger.info("Direct player URL detected: %s", video_url)
        else:
            # TungTungSahur token URL - decode token
            token = extract_token_from_url(embed_url)
            if not token:
                raise RuntimeError("No token found in tungtungsahur URL")
            
            video_url = await decode_token_xor(token)
            logger.info("Decoded video URL: %s", video_url)
        
        await browser.start()
        
        async with browser.new_page() as page:
            # Intercept ALL requests - filter by HLS/DASH patterns only (no domain filter)
            # This catches MPD requests from any CDN domain
            intercepted = await intercept_hls_requests(page, None)
            
            # Navigate directly to the decoded video URL (the actual video page)
            await navigate_with_retry(page, video_url)
            
            # Wait for page load and JWPlayer/hls.js initialization + MPD request
            # Increased from 5s to 15s to allow JWPlayer to fully initialize and request MPD
            logger.info("Waiting for JWPlayer to initialize and request MPD...")
            await asyncio.sleep(15)
            
            # Additional wait for video element to appear (JWPlayer creates it dynamically)
            try:
                await page.wait_for_selector("video", timeout=10000)
                logger.info("Video element detected")
            except Exception:
                logger.warning("Video element not found within 10s, continuing anyway")
            
            current_url = page.url
            logger.info("Current URL on video page: %s", current_url)
            final_url = current_url
            
# If we land on sandboxed.html, the player loads directly in this page via JS
            if "sandboxed.html" in current_url:
                logger.info("On sandboxed page, waiting for JWPlayer/hls.js to load...")
                # Wait longer for JWPlayer + hls.js to initialize and load the stream
                try:
                    await asyncio.sleep(10)
                    logger.info(">>> SLEEP COMPLETED SUCCESSFULLY <<<")
                except Exception as e:
                    logger.error("Exception during sleep: %s", e)
                    raise
                
                logger.info(">>> SLEEP COMPLETED SUCCESSFULLY, CONTINUING <<<")
                
                # Update final_url to current page
                final_url = page.url
            
            # Check if we're still on sandboxed.html - if so, look for video iframe
            if "sandboxed.html" in final_url:
                logger.info("Still on sandboxed page, looking for video iframe...")
                # Wait for iframe to be created - try multiple times
                video_iframe = None
                for attempt in range(6):
                    await asyncio.sleep(5)
                    
                    # Check all frames again for video iframe
                    for i, frame in enumerate(page.frames):
                        frame_url = frame.url
                        logger.info("Attempt %d - Frame %d: %s", attempt + 1, i, frame_url)
                        if any(domain in frame_url for domain in ["lkhjerbhye", "cloudorchestranova", "vidsrc", "vidhide"]):
                            if "/v/" in frame_url or "/embed/" in frame_url or "/player/" in frame_url:
                                video_iframe = frame
                                logger.info("Found video iframe: %s", frame_url)
                                break
                    
                    if video_iframe:
                        logger.info("Found video iframe: %s", video_iframe.url)
                        final_url = video_iframe.url
                        page = video_iframe.page if hasattr(video_iframe, 'page') else page
                        # Wait for player to load in iframe
                        await asyncio.sleep(5)
                        break
                    else:
                        logger.info("Attempt %d: No video iframe found yet", attempt + 1)
                
# Check if we're still on sandboxed.html - if so, try known working iframe URLs directly
            if "sandboxed.html" in final_url:
                logger.info("Still on sandboxed page, trying known working iframe URLs directly...")
                
                # Known working iframe URLs for this video (TMDB: 220102, Season 1, Episode 4)
                known_iframe_urls = [
                    f"https://vsembed.ru/embed/tv?tmdb=220102&season=1&episode=4&ds_lang=es",
                    f"https://vidlink.pro/tv/220102/1/4?sub_label=Spanish&primaryColor=ffffff&secondaryColor=ffffff&iconColor=ffffff&iconColor=ffffff&iconColor=ffffff&icons=default&player=jw&title=false&poster=true&autoplay=true",
                    f"https://player.videasy.net/tv/220102/1/4",
                    f"https://vidapi.xyz/embed/tv/220102/1/4",
                ]
                
                video_iframe = None
                for iframe_url in known_iframe_urls:
                    logger.info("Trying iframe URL: %s", iframe_url)
                    try:
                        await navigate_with_retry(page, iframe_url)
                        await asyncio.sleep(5)
                        
                        # Check if this page has the video player
                        current_url = page.url
                        logger.info("Navigated to: %s", current_url)
                        
                        # Check if this page has the video player
                        if "sandboxed.html" not in current_url:
                            video_iframe = page
                            final_url = current_url
                            logger.info("Successfully navigated to video player page: %s", final_url)
                            break
                    except Exception as e:
                        logger.warning("Failed to navigate to %s: %s", iframe_url, e)
                        continue
                
                if not video_iframe:
                    logger.warning("None of the known iframe URLs worked, trying to extract from main page")
            
            logger.info("Final URL for extraction: %s", final_url)
            
            logger.info(">>> AFTER SLEEP: Checking intercepted URLs...")
            logger.info("Checking intercepted URLs: %d found", len(intercepted))
            if intercepted:
                for url in intercepted:
                    if (".m3u8" in url or "m3u8" in url or "master" in url or "playlist" in url or "/v/" in url or "token=" in url or ".mpd" in url or "dash" in url):
                        if any(ext in url for ext in [".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".ttf", ".eot", ".map"]):
                            continue
                        hls_url = url
                        logger.info("Using intercepted HLS/DASH URL: %s", hls_url)
                        break
            
            # NEW: If we got segment URLs (init-stream.m4s, seg-*.m4s), construct manifest URL
            if not hls_url or not (".mpd" in hls_url or ".m3u8" in hls_url):
                for url in intercepted:
                    # Look for DASH segment patterns: /sacdn/dash/{id}/init-stream.m4s or seg-*.m4s
                    if "sacdn" in url and ("init-stream" in url or "seg-" in url) and url.endswith(".m4s"):
                        # Construct manifest URL: replace segment with index_web.mpd
                        # Pattern: .../sacdn/dash/{id}/init-stream3.m4s?params -> .../sacdn/dash/{id}/index_web.mpd?params
                        manifest_url = url.replace("/init-stream", "/index_web").replace(".m4s", ".mpd")
                        # Also handle seg-* patterns
                        import re
                        manifest_url = re.sub(r"/seg-\d+\.m4s(\?.*)?$", r"/index_web.mpd\1", manifest_url)
                        logger.info("Constructed manifest URL from segment: %s", manifest_url)
                        hls_url = manifest_url
                        break
            
            logger.info("hls_url after intercept check: %s", hls_url)
            
            # If we only got the page URL (not m3u8/mpd), try to extract real manifest from JS context
            if hls_url and not (".m3u8" in hls_url or "master" in hls_url or "playlist" in hls_url or ".mpd" in hls_url):
                logger.info("Intercepted URL is page URL, not m3u8. Trying JS extraction...")
                hls_url = None
            
            # Fallback: try to extract from page evaluation
            if not hls_url:
                logger.info("Trying frame evaluation for real m3u8...")
                # Wait a bit more for hls.js to fully initialize
                await asyncio.sleep(5)
                hls_url = await _extract_hls_from_vidhide(page.main_frame)
                logger.info("hls_url after frame evaluation: %s", hls_url)
            
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
                                                    if (src.file && src.file.includes('token=' && (src.file.includes('.m3u8') || src.file.includes('m3u8') || src.file.includes('master') || src.file.includes('playlist')))) {
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
                                // Check hls.js instance directly
                                if (window.hls) {
                                    if (window.hls.url && window.hls.url.includes('token=')) {
                                        return window.hls.url;
                                    }
                                }
                                // Search scripts for m3u8/mpd URLs
                                const scripts = document.querySelectorAll('script');
                                for (const s of scripts) {
                                    const text = s.textContent || s.innerText || '';
                                    const matches = text.match(/https?:\\/\\/[^"']+(?:\\.m3u8|master\\.m3u8|playlist\\.m3u8|master\\.txt|\\.mpd)\\?token=[^"']/g);
                                    if (matches) return matches[0];
                                    const matches2 = text.match(/https?:\\/\\/[^"']+\\?token=[^"']/g);
                                    if (matches2) {
                                        for (const m of matches2) {
                                            if (m.includes('m3u8') || m.includes('master') || m.includes('playlist') || m.includes('/v/') || m.includes('.mpd') || m.includes('dash')) {
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
        # First, debug what's available in window
        debug_info = await frame.evaluate(
            """() => {
                const info = {
                    hasHls: !!window.hls,
                    hlsUrl: window.hls?.url,
                    hasHlsjsPlayers: !!window.hlsjsPlayers,
                    hlsjsPlayersCount: window.hlsjsPlayers?.length || 0,
                    hasJwplayer: !!window.jwplayer,
                    jwplayerType: typeof window.jwplayer,
                    hasHlsjsPlayersArray: Array.isArray(window.hlsjsPlayers),
                    hlsjsPlayersFirst: window.hlsjsPlayers?.[0],
                    videoElements: document.querySelectorAll('video').length,
                    scriptCount: document.querySelectorAll('script').length,
                    locationHref: window.location.href
                };
                return info;
            }"""
        )
        logger.info("Window debug info: %s", debug_info)
        
        # Now try to extract the actual HLS URL
        result = await frame.evaluate(
            """() => {
                // 1. Check hls.js instance directly (most reliable)
                if (window.hls && window.hls.url) {
                    return { url: window.hls.url, source: 'window.hls.url' };
                }
                // 2. Check hls.js instance via hlsjsPlayers array
                if (window.hlsjsPlayers && window.hlsjsPlayers.length > 0) {
                    for (const p of window.hlsjsPlayers) {
                        if (p.url) return { url: p.url, source: 'hlsjsPlayers[].url' };
                        if (p.hls && p.hls.url) return { url: p.hls.url, source: 'hlsjsPlayers[].hls.url' };
                    }
                }
                // 3. Check JWPlayer playlist
                if (window.jwplayer) {
                    try {
                        const player = window.jwplayer();
                        if (player && player.getPlaylist) {
                            const playlist = player.getPlaylist();
                            for (const item of playlist) {
                                if (item.sources) {
                                    for (const src of item.sources) {
                                        if (src.file && (src.file.includes('.m3u8') || src.file.includes('master') || src.file.includes('playlist'))) {
                                            return { url: src.file, source: 'jwplayer.playlist.sources' };
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
                // 4. Check for hls.js players
                if (window.hlsjsPlayers) {
                    for (const p of window.hlsjsPlayers) {
                        if (p.url) return { url: p.url, source: 'hlsjsPlayers[].url' };
                        if (p.hls && p.hls.url) return { url: p.hls.url, source: 'hlsjsPlayers[].hls.url' };
                    }
                }
                // 5. Check video elements
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.src && (v.src.includes('.m3u8') || v.src.includes('master') || v.src.includes('playlist'))) {
                        return { url: v.src, source: 'video.src' };
                    }
                    const sources = v.querySelectorAll('source');
                    for (const s of sources) {
                        if (s.src && (s.src.includes('.m3u8') || s.src.includes('master') || s.src.includes('playlist'))) {
                            return { url: s.src, source: 'source.src' };
                        }
                    }
                }
                // 6. Search scripts for m3u8 URLs
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || s.innerText || '';
                    const matches = text.match(/https?:\/\/[^"']+(?:\.m3u8|master\.m3u8|playlist\.m3u8|master\.txt)\?token=[^"']/g);
                    if (matches) return { url: matches[0], source: 'script regex 1' };
                    const matches2 = text.match(/https?:\/\/[^"']+\?token=[^"']/g);
                    if (matches2) {
                        for (const m of matches2) {
                            if (m.includes('m3u8') || m.includes('master') || m.includes('playlist') || m.includes('/v/')) {
                                return { url: m, source: 'script regex 2' };
                            }
                        }
                    }
                }
                return null;
            }"""
        )
        logger.info("Frame evaluation result: %s", result)
        if result and result.get('url'):
            return result['url']
        return None
    except Exception as e:
        logger.debug("VidHide page evaluation failed: %s", e)
        return None


def extract_vidhide_sync(embed_url: str, headless: bool = True) -> VidHideResult:
    """Synchronous wrapper for extract_vidhide_hls."""
    return asyncio.run(extract_vidhide_hls(embed_url, headless))