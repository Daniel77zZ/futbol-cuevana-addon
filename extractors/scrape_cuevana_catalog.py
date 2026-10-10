#!/usr/bin/env python3
"""Scrape Cuevana catalog (movies/series) and build Stremio catalog."""

import argparse
import asyncio
import json
import logging
import re
import sys
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from shared.utils import setup_logger

logger = setup_logger("scrape_cuevana_catalog")


async def fetch_page(client: httpx.AsyncClient, url: str) -> Optional[str]:
    """Fetch a page with retries."""
    try:
        response = await client.get(url, timeout=30.0, follow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as e:
        logger.error("Failed to fetch %s: %s", url, e)
        return None


def parse_movie_card(card: BeautifulSoup, base_url: str, content_type: str) -> Optional[dict]:
    """Parse a single movie/series card from Cuevana."""
    try:
        # Find title
        title_elem = card.select_one(".title, .titulo, h3, h2, .movie-title, .series-title, [class*='title']")
        if not title_elem:
            # Try to find any text that looks like a title
            title_elem = card.select_one("a")
        if not title_elem:
            return None
        
        title = title_elem.get_text(strip=True)
        if not title:
            return None
        
        # Clean title
        title = re.sub(r'\s+', ' ', title)
        
        # Find year
        year_elem = card.select_one(".year, .anio, .release, [class*='year'], [class*='anio']")
        year = year_elem.get_text(strip=True) if year_elem else ""
        
        # Extract year from title if not found
        if not year:
            year_match = re.search(r'\b(19|20)\d{2}\b', title)
            if year_match:
                year = year_match.group(0)
        
        # Find poster
        poster_elem = card.select_one("img")
        poster = ""
        if poster_elem:
            poster = poster_elem.get("src") or poster_elem.get("data-src") or poster_elem.get("data-original") or ""
            if poster and not poster.startswith("http"):
                poster = urljoin(base_url, poster)
        
        # Default poster if none found
        if not poster:
            poster = "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=400&h=600&fit=crop"
        
        # Find link to detail page
        link_elem = card.select_one("a[href]")
        detail_url = ""
        if link_elem:
            detail_url = link_elem.get("href", "")
            if detail_url and not detail_url.startswith("http"):
                detail_url = urljoin(base_url, detail_url)
        
        # Extract slug from Cuevana's real detail URL (e.g., /pelicula/a-machu-picchu-proposal)
        # This is the slug Cuevana actually uses, not a generated one from title+year
        slug = ""
        if detail_url:
            # Extract slug from /pelicula/{slug} or /serie/{slug}
            slug_match = re.search(r'/(?:pelicula|serie)/([^/?#]+)', detail_url)
            if slug_match:
                slug = slug_match.group(1)
        
        # Fallback: generate slug from title+year if extraction failed
        if not slug:
            slug = re.sub(r'[^a-z0-9]+', '-', f"{title}-{year}".lower()).strip('-')
        
        prefix = "cu" if content_type == "movie" else "cu"
        content_id = f"{prefix}-{slug}"
        
        # Determine type for Stremio
        stremio_type = "movie" if content_type == "movie" else "series"
        
        # Build description
        desc_parts = []
        if year:
            desc_parts.append(year)
        description = " - ".join(desc_parts) if desc_parts else f"Cuevana {content_type}"
        
        return {
            "id": content_id,
            "name": title,
            "type": stremio_type,
            "poster": poster,
            "description": description,
            "detailUrl": detail_url,
            "year": year,
        }
    except Exception as e:
        logger.warning("Failed to parse %s card: %s", content_type, e)
        return None


async def scrape_cuevana_catalog(url: str, content_type: str) -> list:
    """Scrape Cuevana movies or series catalog."""
    async with httpx.AsyncClient(
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; FutbolCuevanaBot/1.0)",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
        follow_redirects=True,
    ) as client:
        html = await fetch_page(client, url)
        if not html:
            return []
        
        soup = BeautifulSoup(html, "html.parser")
        
        # Find content cards - try multiple selectors
        cards = []
        for selector in [
            ".movie-item", ".pelicula", ".series-item", ".serie",
            ".item", ".card", ".poster", "[class*='movie']", "[class*='pelicula']",
            "[class*='series']", "[class*='serie']", "article", ".grid-item"
        ]:
            cards = soup.select(selector)
            if cards:
                logger.info("Found %d %s cards with selector: %s", len(cards), content_type, selector)
                break
        
        if not cards:
            logger.warning("No cards found with standard selectors, trying generic approach")
            # Try to find all links with images
            cards = soup.select("a:has(img), .item:has(img), div:has(img)")
            logger.info("Found %d potential cards with generic selector", len(cards))
        
        if not cards:
            logger.error("Could not find any content cards")
            return []
        
        # Parse each card
        items = []
        for card in cards:
            item = parse_movie_card(card, url, content_type)
            if item:
                items.append(item)
        
        # Deduplicate by ID
        seen = set()
        unique_items = []
        for item in items:
            if item["id"] not in seen:
                seen.add(item["id"])
                unique_items.append(item)
        
        logger.info("Parsed %d unique %s items", len(unique_items), content_type)
        return unique_items


async def enrich_with_embed_urls(items: list, content_type: str) -> list:
    """Enrich items by fetching detail pages to extract tungtungsahur embed URLs."""
    import re
    
    async with httpx.AsyncClient(
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; FutbolCuevanaBot/1.0)",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
        follow_redirects=True,
        timeout=15.0,
    ) as client:
        for item in items:
            detail_url = item.get("detailUrl", "")
            if not detail_url:
                continue
            
            try:
                response = await client.get(detail_url, timeout=10.0, follow_redirects=True)
                if not response.is_success:
                    continue
                
                html = response.text
                
                # Extract tungtungsahur URLs from data-server attributes
                # Pattern: data-server="https://tungtungsahur.cuevana3k.pro/?token=..."
                patterns = [
                    r'<li[^>]*data-server="([^"]*tungtungsahur[^"]*)"[^>]*>\s*<span[^>]*>Servidor\s+(?:Hyper|Nebula)[^<]*<\/span>\s*<span[^>]*>Reproducir<\/span>',
                    r'<li[^>]*data-server="([^"]*tungtungsahur[^"]*)"[^>]*>',
                    r'data-server="([^"]*tungtungsahur[^"]*)"',
                ]
                
                tungtungsahur_url = None
                for pattern in patterns:
                    matches = re.findall(pattern, html, re.IGNORECASE)
                    if matches:
                        tungtungsahur_url = matches[0]
                        break
                
                if tungtungsahur_url:
                    item["embedUrl"] = tungtungsahur_url
                else:
                    # Fallback to detailUrl
                    item["sourceUrl"] = item.get("detailUrl", "")
                    
            except Exception as e:
                logger.debug("Failed to enrich %s: %s", item.get("id"), e)
                item["sourceUrl"] = item.get("detailUrl", "")
    
    return items


async def main():
    parser = argparse.ArgumentParser(description="Scrape Cuevana catalog")
    parser.add_argument("--type", choices=["movie", "series"], required=True, help="Content type")
    parser.add_argument("--url", required=True, help="URL to scrape")
    parser.add_argument("--output", required=True, help="Output JSON file path")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    logger.info("Scraping Cuevana %s catalog from: %s", args.type, args.url)
    
    items = await scrape_cuevana_catalog(args.url, args.type)
    
    items = await enrich_with_embed_urls(items, args.type)
    
    # Write output
    output_path = args.output
    import os
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    
    logger.info("Catalog written to: %s (%d items)", output_path, len(items))
    
    # Print summary
    for item in items[:10]:
        logger.info("  %s: %s (%s)", item["id"], item["name"], item.get("year", "N/A"))
    if len(items) > 10:
        logger.info("  ... and %d more", len(items) - 10)


if __name__ == "__main__":
    asyncio.run(main())