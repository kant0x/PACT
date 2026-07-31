-- PACT PostgreSQL Schema
-- Run this to initialize the production database

CREATE TABLE IF NOT EXISTS clients (
  client_address VARCHAR(42) PRIMARY KEY,
  display_name VARCHAR(80) NOT NULL,
  total_spent NUMERIC NOT NULL DEFAULT 0,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_address VARCHAR(42) PRIMARY KEY,
  display_name VARCHAR(80) NOT NULL,
  score INTEGER NOT NULL DEFAULT 100,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks INTEGER NOT NULL DEFAULT 0,
  total_volume_streamed NUMERIC NOT NULL DEFAULT 0,
  platform_points NUMERIC NOT NULL DEFAULT 0,
  last_updated BIGINT NOT NULL,
  capability_manifest JSONB NOT NULL,
  wallet_provider VARCHAR(20) NOT NULL DEFAULT 'EXTERNAL',
  wallet_account_type VARCHAR(10) NOT NULL DEFAULT 'EOA',
  controller_address VARCHAR(42),
  circle_wallet_id VARCHAR(64),
  circle_wallet_set_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS task_templates (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  reward_points INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  chain_task_id VARCHAR(255) UNIQUE,
  funding_tx_hash VARCHAR(66) UNIQUE,
  assignment_tx_hash VARCHAR(66),
  collateral_tx_hash VARCHAR(66),
  stream_start_tx_hash VARCHAR(66),
  completion_tx_hash VARCHAR(66),
  settlement_tx_hash VARCHAR(66),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  creator_address VARCHAR(42) NOT NULL,
  preferred_agent_address VARCHAR(42) REFERENCES agents(agent_address),
  agent_address VARCHAR(42) REFERENCES agents(agent_address),
  total_amount NUMERIC NOT NULL,
  estimated_duration_seconds INTEGER NOT NULL,
  stream_rate_per_second NUMERIC NOT NULL,
  status VARCHAR(20) NOT NULL, -- OPEN, ASSIGNED, STREAMING, COMPLETED, DISPUTED, SLASHED, PAUSED
  collateral_locked NUMERIC NOT NULL DEFAULT 0,
  accrued_amount NUMERIC NOT NULL DEFAULT 0,
  withdrawn_amount NUMERIC NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  template_id UUID REFERENCES task_templates(id),
  terms JSONB,
  work_order JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status VARCHAR(20) NOT NULL, -- NEEDS_HUMAN_REVIEW, RESOLVED
  verdict VARCHAR(20), -- NO_FAULT, PARTIAL_FAULT, FULL_FAULT
  slash_pct INTEGER,
  reasoning TEXT,
  arbitrator_provider VARCHAR(50),
  decision_confidence INTEGER,
  arbitration_receipt JSONB,
  human_review JSONB,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE TABLE IF NOT EXISTS reputation_events (
  id UUID PRIMARY KEY,
  agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address),
  task_id UUID NOT NULL REFERENCES tasks(id),
  success BOOLEAN NOT NULL,
  volume_streamed NUMERIC NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_traces (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address),
  messages JSONB NOT NULL,
  tool_calls JSONB NOT NULL,
  deliverable_summary TEXT NOT NULL,
  evidence JSONB NOT NULL,
  consent_to_training BOOLEAN NOT NULL DEFAULT false,
  provider VARCHAR(50) NOT NULL,
  review_status VARCHAR(20) NOT NULL, -- PENDING, APPROVED, REJECTED
  reviewed_at BIGINT,
  reviewer_id VARCHAR(255),
  outcome VARCHAR(20) NOT NULL, -- PENDING, SUCCESS, FAILURE
  created_at BIGINT NOT NULL,
  finalized_at BIGINT
);

CREATE TABLE IF NOT EXISTS deliverables (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address),
  summary TEXT NOT NULL,
  artifacts JSONB NOT NULL,
  evidence JSONB NOT NULL,
  status VARCHAR(20) NOT NULL, -- SUBMITTED, DISPUTED, ACCEPTED
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address),
  provider VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL, -- PLANNING, RUNNING, SUBMITTED, FAILED, BLOCKED
  plan JSONB,
  steps JSONB NOT NULL,
  deliverable_id UUID REFERENCES deliverables(id),
  error TEXT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS agent_api_keys (
  id UUID PRIMARY KEY,
  agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address) ON DELETE CASCADE,
  label VARCHAR(80) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  last_used_at BIGINT,
  next_poll_at BIGINT
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS chain_task_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS funding_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignment_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS collateral_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stream_start_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS settlement_tx_hash VARCHAR(66);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preferred_agent_address VARCHAR(42);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_order JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_provider VARCHAR(20) NOT NULL DEFAULT 'EXTERNAL';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_account_type VARCHAR(10) NOT NULL DEFAULT 'EOA';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS controller_address VARCHAR(42);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS circle_wallet_id VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS circle_wallet_set_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_circle_wallet_id ON agents(circle_wallet_id) WHERE circle_wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_chain_task_id ON tasks(chain_task_id) WHERE chain_task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_funding_tx_hash ON tasks(funding_tx_hash) WHERE funding_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_task_id ON disputes(task_id);
CREATE INDEX IF NOT EXISTS idx_reputation_events_agent ON reputation_events(agent_address);
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON agent_api_keys(agent_address);
