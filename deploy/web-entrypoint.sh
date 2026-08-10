#!/bin/sh
set -eu

api_url="${PACT_WEB_API_URL:-${VITE_API_URL:-}}"
arc_rpc_url="${PACT_WEB_ARC_RPC_URL:-${VITE_ARC_RPC_URL:-https://rpc.testnet.arc.network}}"
vault_address="${PACT_WEB_STREAMING_VAULT_ADDRESS:-${VITE_STREAMING_VAULT_ADDRESS:-}}"
agent_registry_address="${PACT_WEB_AGENT_REGISTRY_ADDRESS:-${VITE_AGENT_REGISTRY_ADDRESS:-}}"
reputation_registry_address="${PACT_WEB_REPUTATION_REGISTRY_ADDRESS:-${VITE_REPUTATION_REGISTRY_ADDRESS:-}}"
work_order_commitments_address="${PACT_WEB_WORK_ORDER_COMMITMENTS_ADDRESS:-${VITE_WORK_ORDER_COMMITMENTS_ADDRESS:-}}"
verification_registry_address="${PACT_WEB_VERIFICATION_REGISTRY_ADDRESS:-${VITE_VERIFICATION_REGISTRY_ADDRESS:-}}"
hub_registry_address="${PACT_WEB_HUB_REGISTRY_ADDRESS:-${VITE_HUB_REGISTRY_ADDRESS:-}}"
milestone_escrow_address="${PACT_WEB_MILESTONE_ESCROW_ADDRESS:-${VITE_MILESTONE_ESCROW_ADDRESS:-}}"
subscription_vault_address="${PACT_WEB_SUBSCRIPTION_VAULT_ADDRESS:-${VITE_SUBSCRIPTION_VAULT_ADDRESS:-}}"
reward_vault_address="${PACT_WEB_REWARD_VAULT_ADDRESS:-${VITE_REWARD_VAULT_ADDRESS:-}}"
usdc_address="${PACT_WEB_USDC_ADDRESS:-${VITE_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/pact-config.js <<EOF
window.__PACT_CONFIG__ = {
  apiUrl: "$(json_escape "$api_url")",
  arcRpcUrl: "$(json_escape "$arc_rpc_url")",
  streamingVaultAddress: "$(json_escape "$vault_address")",
  agentRegistryAddress: "$(json_escape "$agent_registry_address")",
  reputationRegistryAddress: "$(json_escape "$reputation_registry_address")",
  workOrderCommitmentsAddress: "$(json_escape "$work_order_commitments_address")",
  verificationRegistryAddress: "$(json_escape "$verification_registry_address")",
  hubRegistryAddress: "$(json_escape "$hub_registry_address")",
  milestoneEscrowAddress: "$(json_escape "$milestone_escrow_address")",
  subscriptionVaultAddress: "$(json_escape "$subscription_vault_address")",
  rewardVaultAddress: "$(json_escape "$reward_vault_address")",
  usdcAddress: "$(json_escape "$usdc_address")"
};
EOF
