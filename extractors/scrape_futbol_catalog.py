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


async def fetch_page(client: httpx.AsyncClient, url: str) -> Optional[str]:
    """Fetch a page with retries."""
    try:
        response = await client.get(url, timeout=30.0, follow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as e:
        logger.error("Failed to fetch %s: %s", url, e)
        return None


def parse_match_card(card: BeautifulSoup, base_url: str) -> Optional[dict]:
    """Parse a single match card from the agenda page."""
    try:
        # Find teams
        teams_elem = card.select_one(".match-teams, .equipos, .teams, h3, .event-title")
        if not teams_elem:
            return None
        
        teams_text = teams_elem.get_text(strip=True)
        # Clean up team names
        teams_text = re.sub(r'\s+', ' ', teams_text)
        
        # Extract team names (format: "Team A vs Team B" or "Team A - Team B")
        vs_match = re.search(r'(.+?)\s*(?:vs|VS|Vs|-)\s*(.+)', teams_text)
        if vs_match:
            team_a = vs_match.group(1).strip()
            team_b = vs_match.group(2).strip()
        else:
            # Fallback: use the whole text
            team_a = teams_text
            team_b = ""
        
        # Find time
        time_elem = card.select_one(".match-time, .hora, .time, .hour")
        match_time = time_elem.get_text(strip=True) if time_elem else ""
        
        # Find league/competition
        league_elem = card.select_one(".match-league, .liga, .competition, .league")
        league = league_elem.get_text(strip=True) if league_elem else ""
        
        # Find channel
        channel_elem = card.select_one(".match-channel, .canal, .channel, .tv")
        channel = channel_elem.get_text(strip=True) if channel_elem else ""
        
        # Find embed link
        embed_link = None
        for link in card.select("a[href*='embed'], a[href*='eventos']"):
            href = link.get("href", "")
            if "eventos.html" in href or "embed" in href:
                embed_link = urljoin(base_url, href)
                break
        
        # Generate ID from teams
        slug = re.sub(r'[^a-z0-9]+', '-', f"{team_a}-{team_b}".lower()).strip('-')
        match_id = f"fc-{slug}"
        
        # Build description
        desc_parts = []
        if league:
            desc_parts.append(league)
        if match_time:
            desc_parts.append(match_time)
        if channel:
            desc_parts.append(channel)
        description = " - ".join(desc_parts) if desc_parts else "Live football match"
        
        # Build name
        name = f"{team_a} vs {team_b}" if team_b else team_a
        
        return {
            "id": match_id,
            "name": name,
            "type": "tv",
            "poster": f"https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&h=600&fit=crop",  # Generic football poster
            "description": description,
            "embedUrl": embed_link,
            "league": league,
            "time": match_time,
            "channel": channel,
        }
    except Exception as e:
        logger.warning("Failed to parse match card: %s", e)
        return None


async def scrape_futbol_agenda(base_url: str) -> list:
    """Scrape today's matches from futbol agenda."""
    async with httpx.AsyncClient(
        headers={"User-Agent": "Mozilla/5.0 (compatible; FutbolCuevanaBot/1.0)"},
        follow_redirects=True,
    ) as client:
        html = await fetch_page(client, base_url)
        if not html:
            return []
        
        soup = BeautifulSoup(html, "html.parser")
        
        # Find match cards - try multiple selectors
        match_cards = []
        for selector in [
            ".match-card", ".partido", ".event", ".match", 
            ".fixture", ".game", "article.match",
            "[class*='match']", "[class*='partido']", "[class*='event']"
        ]:
            match_cards = soup.select(selector)
            if match_cards:
                logger.info("Found %d matches with selector: %s", len(match_cards), selector)
                break
        
        if not match_cards:
            logger.warning("No match cards found, trying generic approach")
            # Try to find any links that look like match embeds
            all_links = soup.select("a[href*='embed'], a[href*='eventos'], a[href*='partido']")
            logger.info("Found %d potential embed links", len(all_links))
            
            # Create minimal items from links
            items = []
            for i, link in enumerate(all_links[:20]):  # Limit to 20
                href = link.get("href", "")
                text = link.get_text(strip=True)
                if not text:
                    text = f"Match {i+1}"
                items.append({
                    "id": f"fc-match-{i+1}",
                    "name": text,
                    "type": "tv",
                    "poster": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&h=600&fit=crop",
                    "description": "Live football match",
                    "embedUrl": urljoin(base_url, href),
                })
            return items
        
        # Parse each match card
        items = []
        for card in match_cards:
            item = parse_match_card(card, base_url)
            if item:
                items.append(item)
        
        return items


async def resolve_embed_urls(items: list) -> list:
    """Resolve embed URLs by fetching the embed page and finding the actual stream URL."""
    # For now, just pass through the embed URL
    # The actual resolution happens on-demand via the resolve-on-demand workflow
    for item in items:
        if item.get("embedUrl"):
            # Store the embed URL for later resolution
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