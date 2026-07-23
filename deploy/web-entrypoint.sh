#!/bin/sh
set -eu

api_url="${PACT_WEB_API_URL:-${VITE_API_URL:-}}"
api_token="${PACT_WEB_API_TOKEN:-${VITE_API_TOKEN:-}}"
pact_mode="${PACT_WEB_MODE:-${VITE_PACT_MODE:-demo}}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/pact-config.js <<EOF
window.__PACT_CONFIG__ = {
  apiUrl: "$(json_escape "$api_url")",
  apiToken: "$(json_escape "$api_token")",
  pactMode: "$(json_escape "$pact_mode")"
};
EOF
