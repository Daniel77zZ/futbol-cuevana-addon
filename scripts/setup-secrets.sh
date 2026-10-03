#!/usr/bin/env bash
# scripts/setup-secrets.sh
# Configures GitHub secrets and Cloudflare KV namespaces for futbol-cuevana-addon
#
# Usage: ./scripts/setup-secrets.sh
# Requires: gh CLI authenticated (gh auth login), wrangler CLI (npm install -g wrangler)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Check prerequisites
check_prereqs() {
    log_info "Checking prerequisites..."
    
    if ! command -v gh &> /dev/null; then
        log_error "gh CLI not found. Install from https://cli.github.com/"
        exit 1
    fi
    
    if ! command -v wrangler &> /dev/null; then
        log_error "wrangler CLI not found. Install with: npm install -g wrangler"
        exit 1
    fi
    
    # Check gh auth
    if ! gh auth status &> /dev/null; then
        log_error "Not authenticated with gh. Run: gh auth login"
        exit 1
    fi
    
    # Check wrangler auth
    if ! wrangler whoami &> /dev/null; then
        log_error "Not authenticated with wrangler. Run: wrangler login"
        exit 1
    fi
    
    log_success "All prerequisites satisfied"
}

# Get repository name from git remote
get_repo() {
    local repo
    repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
        log_error "Could not determine repository. Run from within the repo or set GH_REPO."
        exit 1
    }
    echo "$repo"
}

# Create KV namespaces
create_kv_namespaces() {
    log_info "Creating Cloudflare KV namespaces..."
    
    # Production namespace
    log_info "Creating production KV namespace..."
    local prod_output
    prod_output=$(wrangler kv namespace create "STREAMS_KV" --preview false 2>&1) || {
        log_error "Failed to create production KV namespace"
        echo "$prod_output"
        exit 1
    }
    
    local prod_id
    prod_id=$(echo "$prod_output" | grep -oP 'id = "\K[^"]+' | head -1)
    if [[ -z "$prod_id" ]]; then
        log_error "Could not extract production KV namespace ID"
        echo "$prod_output"
        exit 1
    fi
    log_success "Production KV namespace ID: $prod_id"
    
    # Preview namespace
    log_info "Creating preview KV namespace..."
    local preview_output
    preview_output=$(wrangler kv namespace create "STREAMS_KV" --preview true 2>&1) || {
        log_error "Failed to create preview KV namespace"
        echo "$preview_output"
        exit 1
    }
    
    local preview_id
    preview_id=$(echo "$preview_output" | grep -oP 'preview_id = "\K[^"]+' | head -1)
    if [[ -z "$preview_id" ]]; then
        log_error "Could not extract preview KV namespace ID"
        echo "$preview_output"
        exit 1
    fi
    log_success "Preview KV namespace ID: $preview_id"
    
    # Store for later use
    echo "$prod_id" > /tmp/kv_prod_id
    echo "$preview_id" > /tmp/kv_preview_id
    
    # Update wrangler.toml with the new IDs
    log_info "Updating wrangler.toml with KV namespace IDs..."
    sed -i "s/id = \"REPLACE_WITH_PRODUCTION_KV_NAMESPACE_ID\"/id = \"$prod_id\"/" workers/addon/wrangler.toml
    sed -i "s/preview_id = \"REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID\"/preview_id = \"$preview_id\"/" workers/addon/wrangler.toml
    log_success "Updated wrangler.toml"
}

# Set GitHub repository secrets
set_github_secrets() {
    local repo="$1"
    
    log_info "Setting GitHub repository secrets for $repo..."
    
    # Required secrets
    local secrets=(
        "CF_API_TOKEN:Cloudflare API Token (with Workers KV permissions)"
        "CF_ACCOUNT_ID:Cloudflare Account ID"
        "CF_KV_NAMESPACE_ID:Production KV Namespace ID"
        "TMDB_API_KEY:TMDB API Key (for metadata)"
        "GH_TOKEN:GitHub Personal Access Token (with workflow scope)"
    )
    
    local prod_id
    prod_id=$(cat /tmp/kv_prod_id 2>/dev/null || echo "")
    
    for secret_desc in "${secrets[@]}"; do
        IFS=':' read -r secret_name secret_prompt <<< "$secret_desc"
        
        # Special handling for CF_KV_NAMESPACE_ID - use the created ID
        if [[ "$secret_name" == "CF_KV_NAMESPACE_ID" && -n "$prod_id" ]]; then
            log_info "Setting $secret_name (auto-detected from KV creation)..."
            echo "$prod_id" | gh secret set "$secret_name" --repo "$repo" --body-file -
            log_success "Set $secret_name"
            continue
        fi
        
        # For other secrets, prompt user
        log_info "Setting $secret_name: $secret_prompt"
        echo -n "Enter value for $secret_name (hidden): "
        read -rs value
        echo
        if [[ -n "$value" ]]; then
            echo "$value" | gh secret set "$secret_name" --repo "$repo" --body-file -
            log_success "Set $secret_name"
        else
            log_warn "Skipped $secret_name (empty value)"
        fi
    done
}

# Verify secrets are set
verify_secrets() {
    local repo="$1"
    
    log_info "Verifying GitHub secrets..."
    gh secret list --repo "$repo"
}

# Main
main() {
    echo "========================================="
    echo "  futbol-cuevana-addon Secrets Setup"
    echo "========================================="
    echo
    
    check_prereqs
    
    local repo
    repo=$(get_repo)
    log_info "Repository: $repo"
    echo
    
    create_kv_namespaces
    echo
    
    set_github_secrets "$repo"
    echo
    
    verify_secrets "$repo"
    echo
    
    log_success "Setup complete!"
    echo
    echo "Next steps:"
    echo "  1. Commit the updated wrangler.toml"
    echo "  2. Push to trigger the workflows"
    echo "  3. Test with: gh workflow run resolve-on-demand.yml -f type=futbol -f id=fc-test -f sourceUrl=https://example.com/embed"
}

main "$@"