import { sql, migrationRunner } from '@forge/sql';

const CREATE_POC = `CREATE TABLE IF NOT EXISTS poc_findings (
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

const migrations = migrationRunner.enqueue('v001_create_poc_findings', CREATE_POC);

export const runMigration = async () => {
  const applied = await migrations.run();
  console.log('Migrations applied:', JSON.stringify(applied));
  const list = await migrationRunner.list();
  list.forEach((m) => console.log(`${m.name} migrated at ${m.migratedAt.toUTCString()}`));
  return applied;
};

export const sqlPoc = async () => {
  const upsert = `INSERT INTO poc_findings (type, severity, source_id, fingerprint, title)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE title = ?`;
  await sql
    .prepare(upsert)
    .bindParams('secret', 4, 'page-1', 'abc123', 'Test finding', 'Test finding')
    .execute();
  const result = await sql
    .prepare('SELECT * FROM poc_findings WHERE status = ?')
    .bindParams('open')
    .execute();
  console.log('Rows:', JSON.stringify(result));
  return result;
};