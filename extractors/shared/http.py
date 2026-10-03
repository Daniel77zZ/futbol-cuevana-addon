"""Playwright stealth browser manager with retry logic."""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from playwright.async_api import Browser, BrowserContext, Page, async_playwright
from playwright_stealth import stealth_async
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

from .utils import setup_logger

logger = setup_logger("http")

DEFAULT_TIMEOUT = 30000  # 30 seconds
NAVIGATION_TIMEOUT = 30000


class StealthBrowser:
    """Manages a stealth Playwright browser instance with retry logic."""

    def __init__(
        self,
        headless: bool = True,
        timeout: int = DEFAULT_TIMEOUT,
        user_agent: Optional[str] = None,
    ):
        self.headless = headless
        self.timeout = timeout
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
        self._browser: Optional[Browser] = None
        self._playwright = None

    async def start(self) -> None:
        """Launch the browser."""
        if self._browser is not None:
            return
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=self.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-web-security",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
        )
        logger.info("Stealth browser started")

    async def stop(self) -> None:
        """Close the browser."""
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        logger.info("Stealth browser stopped")

    @asynccontextmanager
    async def new_context(self, **kwargs) -> AsyncGenerator[BrowserContext, None]:
        """Create a new browser context with stealth applied."""
        if not self._browser:
            await self.start()

        context = await self._browser.new_context(
            user_agent=self.user_agent,
            viewport={"width": 1920, "height": 1080},
            locale="es-AR",
            timezone_id="America/Argentina/Buenos_Aires",
            permissions=["geolocation"],
            geolocation={"latitude": -34.6037, "longitude": -58.3816},
            **kwargs,
        )
        # Apply stealth to context
        await stealth_async(context)
        try:
            yield context
        finally:
            await context.close()

    @asynccontextmanager
    async def new_page(self, **context_kwargs) -> AsyncGenerator[Page, None]:
        """Create a new page with stealth applied."""
        async with self.new_context(**context_kwargs) as context:
            page = await context.new_page()
            page.set_default_timeout(self.timeout)
            page.set_default_navigation_timeout(NAVIGATION_TIMEOUT)
            try:
                yield page
            finally:
                await page.close()


@retry(
    wait=wait_exponential(multiplier=1, min=2, max=10),
    stop=stop_after_attempt(3),
    retry=retry_if_exception_type((TimeoutError, ConnectionError, Exception)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
)
async def navigate_with_retry(page: Page, url: str, wait_until: str = "networkidle") -> None:
    """Navigate to URL with retry logic."""
    logger.info("Navigating to %s", url)
    await page.goto(url, wait_until=wait_until, timeout=DEFAULT_TIMEOUT)


async def wait_for_selector_with_retry(
    page: Page, selector: str, timeout: int = 10000, state: str = "attached"
) -> None:
    """Wait for selector with retry logic."""
    await page.wait_for_selector(selector, timeout=timeout, state=state)


async def click_if_exists(page: Page, selector: str, timeout: int = 5000) -> bool:
    """Click element if it exists, return True if clicked."""
    try:
        await page.wait_for_selector(selector, timeout=timeout, state="visible")
        await page.click(selector, timeout=timeout)
        logger.info("Clicked element: %s", selector)
        return True
    except Exception:
        logger.debug("Element not found or not clickable: %s", selector)
        return False


async def intercept_hls_requests(page: Page, domain_filter: str = "fubo18.com") -> list[str]:
    """Intercept network requests and return HLS URLs matching domain filter."""
    hls_urls: list[str] = []

    def handle_request(request):
        url = request.url
        if domain_filter in url and ".m3u8" in url and "token=" in url:
            hls_urls.append(url)
            logger.info("Intercepted HLS URL: %s", url)

    page.on("request", handle_request)
    return hls_urls