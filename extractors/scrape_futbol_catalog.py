#!/usr/bin/env python3
"""Scrape futbol agenda from futbollibrefullhd.org and build Stremio catalog."""

import argparse
import asyncio
import json
import logging
import re
import sys
from datetime import datetime
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from pydantic import HttpUrl

from shared.utils import setup_logger

logger = setup_logger("scrape_futbol_catalog")


async def fetch_page_playwright(url: str) -> Optional[str]:
    """Fetch a page using Playwright to render JavaScript."""
    try:
        from playwright.async_api import async_playwright
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            )
            page = await context.new_page()
            
            await page.goto(url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(3000)
            
            # Wait for the agenda to load
            try:
                await page.wait_for_selector("#menu li, .card, [data-match]", timeout=10000)
            except:
                pass
            
            await page.wait_for_timeout(2000)
            
            html = await page.content()
            await browser.close()
            return html
    except Exception as e:
        logger.error("Playwright fetch failed for %s: %s", url, e)
        return None


def parse_match_item(item: dict, base_url: str) -> Optional[dict]:
    """Parse a match item from the API/JSON data."""
    try:
        # The API returns matches in a specific format
        team_a = item.get("team_a", "")
        team_b = item.get("team_b", "")
        league = item.get("league", "")
        time_str = item.get("time", "")
        channel = item.get("channel", "")
        embed_url = item.get("embed_url", "")
        
        if not team_a:
            return None
        
        name = f"{team_a} vs {team_b}" if team_b else team_a
        slug = re.sub(r'[^a-z0-9]+', '-', f"{team_a}-{team_b}".lower()).strip('-')
        match_id = f"fc-{slug}"
        
        desc_parts = []
        if item.get("league"):
            desc_parts.append(item["league"])
        if item.get("time"):
            desc_parts.append(item["time"])
        if item.get("channel"):
            desc_parts.append(item["channel"])
        description = " - ".join(desc_parts) if desc_parts else "Live football match"
        
        return {
            "id": f"fc-{re.sub(r'[^a-z0-9]+', '-', team_a.lower()).strip('-')}",
            "name": f"{team_a} vs {team_b}" if team_b else team_a,
            "type": "tv",
            "poster": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&h=600&fit=crop",
            "description": " - ".join([p for p in [item.get("league"), item.get("time"), item.get("channel")] if p]),
            "embedUrl": item.get("embed_url", ""),
            "league": item.get("league", ""),
            "time": item.get("time", ""),
            "channel": item.get("channel", ""),
        }
    except Exception as e:
        logger.warning("Failed to parse match item: %s", e)
        return None


async def scrape_futbol_agenda(base_url: str) -> list:
    """Scrape today's matches from futbol agenda using Playwright."""
    agenda_url = urljoin(base_url, "/agenda")
    
    html = await fetch_page_playwright(agenda_url)
    if not html:
        logger.error("Failed to fetch agenda page")
        return []
    
    # Parse the HTML for match data
    # The page loads data via JavaScript, check for embedded JSON or API calls
    soup = BeautifulSoup(html, "html.parser")
    
    # Look for embedded JSON data
    scripts = soup.find_all("script")
    for script in scripts:
        if script.string and ("matches" in script.string or "agenda" in script.string or "partidos" in script.string):
            # Try to extract JSON data
            text = script.string
            # Look for JSON arrays
            json_matches = re.findall(r'\[.*?\]', text, re.DOTALL)
            for match in json_matches:
                try:
                    data = json.loads(match)
                    if isinstance(data, list) and len(data) > 0:
                        logger.info("Found JSON data with %d items", len(data))
                        return data
                except:
                    pass
    
    # Fallback: try to find match data in the page
    items = []
    soup = BeautifulSoup(html, "html.parser")
    
    # Look for match cards
    for card in soup.select(".card, .match, .partido, .event, .fixture, .game, [class*='match'], [class*='partido'], [class*='event']"):
        try:
            text = card.get_text(strip=True)
            if not text or len(text) < 10:
                continue
            
            # Try to extract team names, time, channel
            link = card.find("a", href=True)
            embed_url = urljoin("https://futbollibrefullhd.org/", link["href"]) if link else ""
            
            text = card.get_text(strip=True)
            if len(text) < 5:
                continue
                
            # Try to extract teams
            vs_match = re.search(r'(.+?)\s*(?:vs|VS|Vs|-)\s*(.+)', text)
            if vs_match:
                team_a = vs_match.group(1).strip()
                team_b = vs_match.group(2).strip()
            else:
                # Try to split by common separators
                parts = re.split(r'\s+vs\s+|\s+-\s+', text, 1)
                if len(parts) == 2:
                    team_a, team_b = parts[0].strip(), parts[1].strip()
                else:
                    team_a = text[:50]
                    team_b = ""
            
            # Find time
            time_match = re.search(r'\d{1,2}:\d{2}', text)
            match_time = time_match.group(0) if time_match else ""
            
            # Find channel
            channel_match = re.search(r'(ESPN|Fox Sports|DirecTV|TyC|TNT|Star|Disney|Bein|Gol)', text, re.IGNORECASE)
            channel = channel_match.group(0) if channel_match else ""
            
            if not team_a:
                continue
                
            name = f"{team_a} vs {team_b}" if team_b else team_a
            slug = re.sub(r'[^a-z0-9]+', '-', f"{team_a}-{team_b}".lower()).strip('-')
            match_id = f"fc-{slug}"
            
            # Find embed link
            embed_link = ""
            for link in card.find_all("a", href=True):
                href = link["href"]
                if "embed" in href or "eventos" in href or "partido" in href or "match" in href:
                    embed_url = urljoin("https://futbollibrefullhd.org/", href)
                    embed_url = embed_url
                    break
            
            items.append({
                "id": match_id,
                "name": name,
                "type": "tv",
                "poster": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&h=600&fit=crop",
                "description": " - ".join(filter(None, ["", "", ""])),
                "embedUrl": embed_url,
                "league": "",
                "time": "",
                "channel": "",
            })
        except Exception as e:
            logger.warning("Failed to parse card: %s", e)
    
    # If no items found, try to find embed links directly
    if not items:
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.find_all("a", href=True):
            href = link.get("href", "")
            if any(x in href for x in ["embed", "eventos", "partido", "match", "watch"]):
                text = link.get_text(strip=True) or "Match"
                items.append({
                    "id": f"fc-{re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')}",
                    "name": text,
                    "type": "tv",
                    "poster": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&h=600&fit=crop",
                    "description": "Live football match",
                    "embedUrl": urljoin("https://futbollibrefullhd.org/", href),
                    "league": "",
                    "time": "",
                    "channel": "",
                })
    
    return items


async def resolve_embed_urls(items: list) -> list:
    """Resolve embed URLs by storing the embed URL for later resolution."""
    for item in items:
        if item.get("embedUrl"):
            item["sourceUrl"] = item["embedUrl"]
    return items


async def main():
    parser = argparse.ArgumentParser(description="Scrape futbol agenda and build catalog")
    parser.add_argument("--base-url", default="https://futbollibrefullhd.org/", help="Base URL to scrape")
    parser.add_argument("--output", required=True, help="Output JSON file path")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    logger.info("Scraping futbol agenda from: %s", args.base_url)
    
    items = await scrape_futbol_agenda(args.base_url)
    logger.info("Found %d matches", len(items))
    
    items = await resolve_embed_urls(items)
    
    # Write output
    output_path = args.output
    import os
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    
    logger.info("Catalog written to: %s (%d items)", output_path, len(items))
    
    # Print summary
    for item in items[:10]:
        logger.info("  %s: %s", item["id"], item["name"])
    if len(items) > 10:
        logger.info("  ... and %d more", len(items) - 10)


if __name__ == "__main__":
    asyncio.run(main())
