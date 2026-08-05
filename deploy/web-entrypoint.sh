#!/bin/sh
set -eu

api_url="${PACT_WEB_API_URL:-${VITE_API_URL:-}}"
arc_rpc_url="${PACT_WEB_ARC_RPC_URL:-${VITE_ARC_RPC_URL:-https://rpc.testnet.arc.network}}"
vault_address="${PACT_WEB_STREAMING_VAULT_ADDRESS:-${VITE_STREAMING_VAULT_ADDRESS:-}}"
usdc_address="${PACT_WEB_USDC_ADDRESS:-${VITE_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/pact-config.js <<EOF
window.__PACT_CONFIG__ = {
  apiUrl: "$(json_escape "$api_url")",
  arcRpcUrl: "$(json_escape "$arc_rpc_url")",
  streamingVaultAddress: "$(json_escape "$vault_address")",
  usdcAddress: "$(json_escape "$usdc_address")"
};
EOF
