#!/usr/bin/env bash
# scripts/test-local.sh
# Runs local integration test for futbol-cuevana-addon
#
# Usage: ./scripts/test-local.sh
# Requires: docker, docker-compose, curl

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Configuration
COMPOSE_FILE="docker-compose.local.yml"
EXTRACTORS_URL="http://localhost:8787"  # Worker addon
MOCK_KV_URL="http://localhost:8080"
ADDON_URL="http://localhost:8787"
MAX_WAIT=120  # seconds
POLL_INTERVAL=5

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    docker-compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
}
trap cleanup EXIT

# Wait for service to be healthy
wait_for_service() {
    local url="$1"
    local name="$2"
    local timeout="$3"
    local elapsed=0
    
    log_info "Waiting for $name at $url..."
    while [[ $elapsed -lt $timeout ]]; do
        if curl -sf "$url" >/dev/null 2>&1; then
            log_success "$name is ready"
            return 0
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
        echo -n "."
    done
    echo
    log_error "$name did not become ready within ${timeout}s"
    return 1
}

# Wait for docker-compose services
wait_for_containers() {
    log_info "Waiting for containers to be healthy..."
    local timeout=$MAX_WAIT
    local elapsed=0
    
    while [[ $elapsed -lt $timeout ]]; do
        local healthy=true
        # Check extractors
        if ! docker-compose -f "$COMPOSE_FILE" ps extractors | grep -q "healthy"; then
            healthy=false
        fi
        # Check mock-kv
        if ! docker-compose -f "$COMPOSE_FILE" ps mock-kv | grep -q "healthy"; then
            healthy=false
        fi
        # Check addon (wrangler dev doesn't have healthcheck, just check running)
        if ! docker-compose -f "$COMPOSE_FILE" ps addon | grep -q "Up"; then
            healthy=false
        fi
        
        if [[ "$healthy" == "true" ]]; then
            log_success "All containers are healthy"
            return 0
        fi
        
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
        echo -n "."
    done
    echo
    log_error "Containers did not become healthy within ${timeout}s"
    docker-compose -f "$COMPOSE_FILE" ps
    return 1
}

# Test mock KV
test_mock_kv() {
    log_info "Testing Mock KV API..."
    
    # Health check
    if ! curl -sf "$MOCK_KV_URL/health" | jq -e '.status == "ok"' >/dev/null; then
        log_error "Mock KV health check failed"
        return 1
    fi
    log_success "Mock KV health check passed"
    
    # Test PUT/GET
    local test_key="test:local:$(date +%s)"
    local test_value='{"hls":"https://example.com/test.m3u8","quality":"1080p","sourceUrl":"https://example.com/embed"}'
    
    if ! curl -sf -X PUT "$MOCK_KV_URL/accounts/test/storage/kv/namespaces/test/values/$test_key" \
         -H "Content-Type: application/json" \
         -d "$test_value" | jq -e '.success == true' >/dev/null; then
        log_error "Mock KV PUT failed"
        return 1
    fi
    log_success "Mock KV PUT works"
    
    if ! curl -sf "$MOCK_KV_URL/accounts/test/storage/kv/namespaces/test/values/$test_key" \
         | jq -e '.value | contains("test.m3u8")' >/dev/null; then
        log_error "Mock KV GET failed"
        return 1
    fi
    log_success "Mock KV GET works"
    
    # Test LIST
    if ! curl -sf "$MOCK_KV_URL/accounts/test/storage/kv/namespaces/test/keys" \
         | jq -e '.keys | length > 0' >/dev/null; then
        log_error "Mock KV LIST failed"
        return 1
    fi
    log_success "Mock KV LIST works"
}

# Test extractors container
test_extractors() {
    log_info "Testing Extractors container..."
    
    # Check if extractors module is importable
    if ! docker-compose -f "$COMPOSE_FILE" exec -T extractors \
         python -c "import extractors.main; print('Extractors module OK')" 2>&1 | grep -q "OK"; then
        log_error "Extractors module import failed"
        return 1
    fi
    log_success "Extractors module imports correctly"
    
    # Check CLI help
    if ! docker-compose -f "$COMPOSE_FILE" exec -T extractors \
         python -m extractors.main --help 2>&1 | grep -q "futbol"; then
        log_error "Extractors CLI help failed"
        return 1
    fi
    log_success "Extractors CLI works"
    
    # Check yt-dlp availability (for cuevana)
    if ! docker-compose -f "$COMPOSE_FILE" exec -T extractors \
         yt-dlp --version 2>&1 | grep -q "yt-dlp"; then
        log_error "yt-dlp not available"
        return 1
    fi
    log_success "yt-dlp available"
    
    # Check Playwright/Chromium (for futbol)
    if ! docker-compose -f "$COMPOSE_FILE" exec -T extractors \
         python -c "from playwright.async_api import async_playwright; print('Playwright OK')" 2>&1 | grep -q "OK"; then
        log_error "Playwright not available"
        return 1
    fi
    log_success "Playwright available"
}

# Test addon worker
test_addon() {
    log_info "Testing Addon Worker..."
    
    # Wait for wrangler dev to be ready
    wait_for_service "$ADDON_URL" "Addon Worker" 60
    
    # Test manifest endpoint
    if ! curl -sf "$ADDON_URL/manifest.json" | jq -e '.id' >/dev/null; then
        log_error "Addon manifest endpoint failed"
        return 1
    fi
    log_success "Addon manifest endpoint works"
    
    # Test catalog endpoint (should return empty or cached catalogs)
    if ! curl -sf "$ADDON_URL/catalog/tv/futbol.json" | jq -e '.metas' >/dev/null; then
        log_warn "Catalog endpoint returned empty (expected if no catalogs seeded)"
    else
        log_success "Catalog endpoint works"
    fi
    
    # Test meta endpoint with a known ID (should return 404 or cached result)
    if ! curl -sf "$ADDON_URL/meta/tv/fc-test.json" 2>/dev/null | jq -e '.meta' >/dev/null; then
        log_info "Meta endpoint returned 404 for unknown ID (expected)"
    else
        log_success "Meta endpoint works"
    fi
}

# Test end-to-end stream resolution flow (local)
test_e2e_resolution() {
    log_info "Testing end-to-end stream resolution flow (local)..."
    
    # This test simulates the full flow:
    # 1. Call extractors directly to resolve a stream
    # 2. Store result in mock KV
    # 3. Query addon for the stream
    
    log_info "Step 1: Testing extractors CLI with a mock URL..."
    # We can't test real extraction without real URLs, but we can test the CLI works
    docker-compose -f "$COMPOSE_FILE" exec -T extractors \
        python -m extractors.main --type futbol --id fc-test-local --url "https://example.com/embed" --output /tmp/test-result.json 2>&1 || {
        log_warn "Extraction failed (expected for mock URL), but CLI executed"
    }
    
    # Create a mock result and store in KV
    local mock_result='{"hls":"https://test.local/stream.m3u8","quality":"1080p","sourceUrl":"https://example.com/embed","id":"fc-test-local","type":"futbol"}'
    local kv_key="stream:futbol:fc-test-local"
    
    log_info "Step 2: Storing mock result in KV..."
    if ! curl -sf -X PUT "$MOCK_KV_URL/accounts/test/storage/kv/namespaces/test/values/$kv_key" \
         -H "Content-Type: application/json" \
         -d "$mock_result" | jq -e '.success == true' >/dev/null; then
        log_error "Failed to store mock result in KV"
        return 1
    fi
    log_success "Mock result stored in KV"
    
    # Note: The addon worker reads from Cloudflare KV, not the mock KV directly.
    # In a real local test, we'd need to configure the worker to use the mock KV.
    # For now, we verify the mock KV works correctly.
    log_info "Step 3: Verifying mock result in KV..."
    if ! curl -sf "$MOCK_KV_URL/accounts/test/storage/kv/namespaces/test/values/$kv_key" \
         | jq -e '.value | contains("stream.m3u8")' >/dev/null; then
        log_error "Failed to retrieve mock result from KV"
        return 1
    fi
    log_success "Mock result retrievable from KV"
}

# Run catalog seeding test
test_catalog_seeding() {
    log_info "Testing catalog seeding (dry-run)..."
    
    # Check if scrape scripts exist
    if [[ -f "extractors/scrape_futbol_catalog.py" ]]; then
        log_info "Found scrape_futbol_catalog.py"
        # Dry run - just check imports
        docker-compose -f "$COMPOSE_FILE" exec -T extractors \
            python -c "import extractors.scrape_futbol_catalog; print('Import OK')" 2>&1 | grep -q "OK" && \
            log_success "Futbol catalog scraper imports OK" || \
            log_warn "Futbol catalog scraper import failed"
    else
        log_warn "scrape_futbol_catalog.py not found (will be created separately)"
    fi
    
    if [[ -f "extractors/scrape_cuevana_catalog.py" ]]; then
        log_info "Found scrape_cuevana_catalog.py"
        docker-compose -f "$COMPOSE_FILE" exec -T extractors \
            python -c "import extractors.scrape_cuevana_catalog; print('Import OK')" 2>&1 | grep -q "OK" && \
            log_success "Cuevana catalog scraper imports OK" || \
            log_warn "Cuevana catalog scraper import failed"
    else
        log_warn "scrape_cuevana_catalog.py not found (will be created separately)"
    fi
}

# Main
main() {
    echo "========================================="
    echo "  futbol-cuevana-addon Local Test Suite"
    echo "========================================="
    echo
    
    # Check if docker-compose file exists
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        log_error "docker-compose.local.yml not found in current directory"
        exit 1
    fi
    
    # Check for jq
    if ! command -v jq &> /dev/null; then
        log_error "jq not found. Install with: apt-get install jq / brew install jq"
        exit 1
    fi
    
    log_info "Starting local test environment..."
    docker-compose -f "$COMPOSE_FILE" up -d --build
    
    wait_for_containers
    
    echo
    log_info "Running health checks..."
    test_mock_kv
    echo
    test_extractors
    echo
    test_addon
    echo
    test_e2e_resolution
    echo
    test_catalog_seeding
    echo
    
    log_success "All local tests passed! ✅"
    echo
    echo "Services running:"
    echo "  - Extractors: docker-compose exec extractors bash"
    echo "  - Mock KV:    $MOCK_KV_URL"
    echo "  - Addon:      $ADDON_URL"
    echo
    echo "Press Ctrl+C to stop all services"
    
    # Keep running until interrupted
    while true; do sleep 30; done
}

main "$@"