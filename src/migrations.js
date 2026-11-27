import { migrationRunner } from '@forge/sql';

const DECISIONS = `CREATE TABLE decisions (
  id CHAR(36) PRIMARY KEY,
  project_key VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  page_title VARCHAR(255) NOT NULL,
  page_version INT NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  decision_text TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  supersedes_id CHAR(36) NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_decision (page_id, block_id, page_version),
  INDEX idx_decision_project (project_key, status)
)`;

const FINDINGS = `CREATE TABLE findings (
  id CHAR(36) PRIMARY KEY,
  project_key VARCHAR(64) NOT NULL,
  release_id VARCHAR(64) NULL,
  type VARCHAR(32) NOT NULL,
  severity TINYINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  detail TEXT NULL,
  redacted_preview VARCHAR(64) NULL,
  evidence_confidence TINYINT NOT NULL DEFAULT 100,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  UNIQUE KEY uq_finding (project_key, type, source_id, fingerprint),
  INDEX idx_finding_status (project_key, status),
  INDEX idx_finding_release (release_id)
)`;

const FINDING_EVENTS = `CREATE TABLE finding_events (
  id CHAR(36) PRIMARY KEY,
  finding_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  actor_account_id VARCHAR(128) NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fe_finding (finding_id, created_at)
)`;

const PROCESSED_EVENTS = `CREATE TABLE processed_events (
  event_key VARCHAR(191) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const SCAN_STATE = `CREATE TABLE scan_state (
  id CHAR(36) PRIMARY KEY,
  project_key VARCHAR(64) NOT NULL,
  scan_type VARCHAR(32) NOT NULL,
  cursor_value VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  items_scanned INT NOT NULL DEFAULT 0,
  last_started_at DATETIME NULL,
  last_finished_at DATETIME NULL,
  error_text VARCHAR(500) NULL,
  UNIQUE KEY uq_scan (project_key, scan_type)
)`;

const DECISION_FEEDBACK = `CREATE TABLE decision_feedback (
  id CHAR(36) PRIMARY KEY,
  decision_id CHAR(36) NOT NULL,
  finding_id CHAR(36) NULL,
  account_id VARCHAR(128) NOT NULL,
  verdict VARCHAR(32) NOT NULL,
  comment VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_df_decision (decision_id)
)`;

const PROJECT_RULES = `CREATE TABLE project_rules (
  id CHAR(36) PRIMARY KEY,
  project_key VARCHAR(64) NOT NULL,
  rule_key VARCHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  config TEXT NULL,
  updated_by VARCHAR(128) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rule (project_key, rule_key)
)`;

const RELEASE_ASSESSMENTS = `CREATE TABLE release_assessments (
  id CHAR(36) PRIMARY KEY,
  project_key VARCHAR(64) NOT NULL,
  release_id VARCHAR(64) NOT NULL,
  score INT NOT NULL,
  band VARCHAR(16) NOT NULL,
  blocked_reason VARCHAR(255) NULL,
  evidence_confidence TINYINT NOT NULL,
  open_findings INT NOT NULL DEFAULT 0,
  breakdown TEXT NOT NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ra_release (project_key, release_id, computed_at)
)`;

const FINDINGS_REMEDIATION = `ALTER TABLE findings
  ADD COLUMN remediation_issue_key VARCHAR(32) NULL,
  ADD COLUMN remediation_claimed_at DATETIME NULL`;

const SECRET_ALLOWLIST = `CREATE TABLE secret_allowlist (
  id CHAR(36) PRIMARY KEY,
  scope VARCHAR(16) NOT NULL,
  value VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_by VARCHAR(128) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_allow (scope, value)
)`;

const DECISIONS_TEMPLATE_FIELDS = `ALTER TABLE decisions
  ADD COLUMN title VARCHAR(255) NULL,
  ADD COLUMN scope VARCHAR(255) NULL,
  ADD COLUMN rationale TEXT NULL`;

// v001 made a throw-away test table in the first proof of concept. It stays in the list so the
// order of already-applied migrations does not change; v013 removes the leftover table.
const POC_TABLE = `CREATE TABLE IF NOT EXISTS poc_findings (
  id BIGINT PRIMARY KEY AUTO_RANDOM,
  type VARCHAR(32) NOT NULL,
  severity TINYINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  source_id VARCHAR(128) NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_poc (type, source_id, fingerprint),
  INDEX idx_poc_status (status)
)`;

export const MIGRATION_LIST = [
  ['v001_create_poc_findings', POC_TABLE],
  ['v002_create_decisions', DECISIONS],
  ['v003_create_findings', FINDINGS],
  ['v004_create_finding_events', FINDING_EVENTS],
  ['v005_create_processed_events', PROCESSED_EVENTS],
  ['v006_create_scan_state', SCAN_STATE],
  ['v007_create_decision_feedback', DECISION_FEEDBACK],
  ['v008_create_project_rules', PROJECT_RULES],
  ['v009_create_release_assessments', RELEASE_ASSESSMENTS],
  ['v010_findings_remediation', FINDINGS_REMEDIATION],
  ['v011_create_secret_allowlist', SECRET_ALLOWLIST],
  ['v012_decisions_template_fields', DECISIONS_TEMPLATE_FIELDS],
  ['v013_drop_poc_findings', 'DROP TABLE IF EXISTS poc_findings'],
];
export const MIGRATION_NAMES = MIGRATION_LIST.map(([name]) => name);

let migrations = migrationRunner;
for (const [name, statement] of MIGRATION_LIST) migrations = migrations.enqueue(name, statement);

export const runMigration = async () => {
  const applied = await migrations.run();
  console.log('Migrations applied:', JSON.stringify(applied));
  return applied;
};

export const listMigrations = async () => migrationRunner.list();