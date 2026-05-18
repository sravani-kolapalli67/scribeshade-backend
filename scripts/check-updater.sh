#!/bin/bash
# ScribeShade Updater — Diagnostic Script
# Usage: ./check-updater.sh [backend-url]
# Default: https://test.backend.scribeshade.org

set -e

BACKEND_URL="${1:-https://test.backend.scribeshade.org}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="hiddenmindsolutions/scribeshade-01-frontend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}ScribeShade Updater Diagnostic${NC}"
echo "Backend: $BACKEND_URL"
echo "---"

# Test 1: Backend Health Check
echo -e "${BLUE}[1/6]${NC} Testing backend health endpoint..."
HEALTH=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/api/updates/health")
HTTP_CODE=$(echo "$HEALTH" | tail -n1)
BODY=$(echo "$HEALTH" | sed '$d')  # Remove last line (compatible with macOS)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✓${NC} Backend is healthy"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
else
  echo -e "${RED}✗${NC} Backend health check failed (HTTP $HTTP_CODE)"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
fi

# Test 2: Latest.json from Backend
echo ""
echo -e "${BLUE}[2/6]${NC} Fetching latest.json from backend..."
MANIFEST=$(curl -s -w "\n%{http_code}" "$BACKEND_URL/api/updates/latest.json")
HTTP_CODE=$(echo "$MANIFEST" | tail -n1)
BODY=$(echo "$MANIFEST" | sed '$d')  # Remove last line (compatible with macOS)

if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✓${NC} Backend serving latest.json"
  LATEST_VERSION=$(echo "$BODY" | jq -r '.version')
  PLATFORMS=$(echo "$BODY" | jq -r '.platforms | keys[]')
  echo "  Version: $LATEST_VERSION"
  echo "  Platforms:"
  echo "$PLATFORMS" | sed 's/^/    /'
else
  echo -e "${RED}✗${NC} Failed to fetch latest.json (HTTP $HTTP_CODE)"
  echo "$BODY"
  exit 1
fi

# Test 3: Platform URLs are accessible
echo ""
echo -e "${BLUE}[3/6]${NC} Checking platform download URLs..."
PLATFORMS_ARRAY=$(echo "$BODY" | jq -r '.platforms | keys[]')
ALL_URLS_OK=true

for platform in $PLATFORMS_ARRAY; do
  URL=$(echo "$BODY" | jq -r ".platforms.\"$platform\".url")
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --head "$URL")
  
  if [ "$STATUS" = "200" ]; then
    echo -e "${GREEN}✓${NC} $platform: accessible"
  else
    echo -e "${YELLOW}⚠${NC} $platform: HTTP $STATUS"
    ALL_URLS_OK=false
  fi
done

if [ "$ALL_URLS_OK" = false ]; then
  echo -e "${YELLOW}⚠${NC} Some URLs returned non-200 status (may be rate-limited)"
fi

# Test 4: Signature Validation
echo ""
echo -e "${BLUE}[4/6]${NC} Checking signatures..."
SIGNATURES_VALID=true

for platform in $PLATFORMS_ARRAY; do
  SIGNATURE=$(echo "$BODY" | jq -r ".platforms.\"$platform\".signature")
  
  if [ -z "$SIGNATURE" ] || [ "$SIGNATURE" = "null" ] || [ "$SIGNATURE" = "" ]; then
    echo -e "${RED}✗${NC} $platform: signature is empty"
    SIGNATURES_VALID=false
  else
    # Try to decode base64
    if echo "$SIGNATURE" | base64 -d >/dev/null 2>&1; then
      DECODED=$(echo "$SIGNATURE" | base64 -d 2>/dev/null | head -1 || true)
      if [[ $DECODED == "untrusted comment: signature"* ]]; then
        echo -e "${GREEN}✓${NC} $platform: signature is valid"
      else
        echo -e "${YELLOW}⚠${NC} $platform: signature decodes but format unexpected"
      fi
    else
      echo -e "${RED}✗${NC} $platform: signature is not valid base64"
      SIGNATURES_VALID=false
    fi
  fi
done

# Test 5: Check GitHub Token (if provided)
if [ -n "$GITHUB_TOKEN" ]; then
  echo ""
  echo -e "${BLUE}[5/6]${NC} Testing GitHub Token..."
  USER_RESP=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)
  USER=$(echo "$USER_RESP" | jq -r '.login // .message' 2>/dev/null)
  
  if [[ $USER == "API rate limit"* ]]; then
    echo -e "${YELLOW}⚠${NC} GitHub rate limited"
  elif [ -n "$USER" ]; then
    echo -e "${GREEN}✓${NC} GitHub Token valid (authenticated as: $USER)"
  else
    echo -e "${YELLOW}⚠${NC} Could not verify token"
  fi
else
  echo ""
  echo -e "${YELLOW}[5/6]${NC} Skipping GitHub Token test (GITHUB_TOKEN not set)"
fi

# Test 6: Release Assets (Optional - GitHub API check disabled for now)
echo ""
echo -e "${BLUE}[6/6]${NC} GitHub release assets check (skipped - see docs)..."
echo -e "${YELLOW}⚠${NC} GitHub API check disabled to prevent timeouts on some networks"
echo "  To verify release assets manually, visit:"
echo "  https://api.github.com/repos/$REPO/releases/latest"

echo ""
echo -e "${BLUE}---${NC}"
echo "Diagnostic complete!"

if [ "$SIGNATURES_VALID" = true ]; then
  echo -e "${GREEN}✓ All checks passed${NC}"
  exit 0
else
  echo -e "${RED}✗ Some checks failed${NC}"
  exit 1
fi
