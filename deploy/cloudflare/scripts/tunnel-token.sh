#!/usr/bin/env sh
# Print the connector token of the stage's tunnel (paste into the VPS .env as TUNNEL_TOKEN).
# Uses the Cloudflare API with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# (CF_API_TOKEN / CF_ACCOUNT_ID also accepted). Needs "Cloudflare Tunnel: Read".
# Exit codes: 1 = credentials, permission or network problem; 2 = stage not deployed.
set -eu
STAGE="${1:-${ALCHEMY_STAGE:-prod}}"
TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
if [ -z "$TOKEN" ] || [ -z "$ACCOUNT" ]; then
  echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or CF_API_TOKEN / CF_ACCOUNT_ID)." >&2
  exit 1
fi
NAME="paperclip-$STAGE"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/cfd_tunnel"

api_get() {
  # Prints the response body; a non-2xx answer or network failure exits 1 with the API's message.
  body=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$1") || {
    echo "Could not reach the Cloudflare API." >&2
    exit 1
  }
  status=$(printf '%s' "$body" | tail -n 1)
  body=$(printf '%s' "$body" | sed '$d')
  case "$status" in
    2*) printf '%s' "$body" ;;
    *)
      echo "Cloudflare API returned HTTP $status for $1" >&2
      printf '%s\n' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const e of JSON.parse(s).errors||[])console.error("  "+e.code+": "+e.message)}catch{}})'
      echo "Check CLOUDFLARE_API_TOKEN (needs Cloudflare Tunnel: Read on this account) and CLOUDFLARE_ACCOUNT_ID." >&2
      exit 1
      ;;
  esac
}

TUNNEL_ID=$(api_get "$API?name=$NAME&is_deleted=false" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result||[];if(!r.length){process.exit(2)}process.stdout.write(r[0].id)})') \
  || { rc=$?; [ "$rc" -eq 2 ] && echo "No tunnel named $NAME on account $ACCOUNT. Deploy the stage first (pnpm run deploy)." >&2; exit "$rc"; }

api_get "$API/$TUNNEL_ID/token" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).result+"\n")})'
