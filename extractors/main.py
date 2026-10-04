"""CLI entry point for extractors."""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Optional

from pydantic import HttpUrl

from .tvf90 import extract_tvf90_hls, TVF90Result
from .cuevana import extract_cuevana_hls, CuevanaResult
from shared.utils import setup_logger

logger = setup_logger("main")


class ExtractionError(Exception):
    """Custom exception for extraction errors."""
    pass


async def run_extraction(
    extract_type: str,
    embed_url: str,
    headless: bool = True,
) -> dict:
    """
    Run extraction based on type.

    Args:
        extract_type: 'futbol' (tvf90), 'cine' or 'series' (cuevana hosts)
        embed_url: The embed URL to extract from
        headless: Run browser in headless mode (for tvf90)

    Returns:
        Dictionary with hls, quality, sourceUrl
    """
    if extract_type == "futbol":
        logger.info("Running tvf90 extraction for: %s", embed_url)
        result: TVF90Result = await extract_tvf90_hls(embed_url, headless=headless)
        return result.model_dump(mode="json")
    elif extract_type in ("cine", "series"):
        logger.info("Running cuevana extraction for: %s", embed_url)
        result: CuevanaResult = await extract_cuevana_hls(embed_url)
        return result.model_dump(mode="json")
    else:
        raise ValueError(f"Unknown extract type: {extract_type}. Use 'futbol', 'cine', or 'series'")


def main() -> int:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Extract HLS URLs from futbol/cine/series embed pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m extractors.main --type futbol --id fc-river-boca \\
       --url "https://tvf90.com/1.php?stream=sportv" --output /tmp/result.json

  python -m extractors.main --type cine --id cu-resident-evil \\
       --url "https://fembed.net/v/abc123" --output /tmp/result.json

  python -m extractors.main --type series --id cu-breaking-bad-s01e01 \\
       --url "https://gounlimited.to/embed/xyz123" --output /tmp/result.json
        """,
    )
    parser.add_argument(
        "--type",
        choices=["futbol", "cine", "series"],
        required=True,
        help="Extraction type: futbol (tvf90), cine or series (cuevana hosts)",
    )
    parser.add_argument(
        "--id",
        required=True,
        help="Content ID (e.g., fc-river-boca, cu-resident-evil)",
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Embed URL to extract from",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output JSON file path",
    )
    parser.add_argument(
        "--no-headless",
        action="store_true",
        help="Run browser in headed mode (for debugging)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    if args.verbose:
        import logging
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("extractors").setLevel(logging.DEBUG)

    try:
        # Run extraction
        result = asyncio.run(run_extraction(
            extract_type=args.type,
            embed_url=args.url,
            headless=not args.no_headless,
        ))

        # Add metadata
        result["id"] = args.id
        result["type"] = args.type

        # Write output
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        logger.info("Extraction successful. Output written to: %s", output_path)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    except ExtractionError as e:
        logger.error("Extraction failed: %s", e)
        print(json.dumps({"error": str(e), "id": args.id, "type": args.type}), file=sys.stderr)
        return 1
    except Exception as e:
        logger.exception("Unexpected error: %s", e)
        print(json.dumps({"error": f"Unexpected error: {e}", "id": args.id, "type": args.type}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())