import sql from '@forge/sql';

export async function ping(payload) {
  const r = await sql
    .prepare('SELECT COUNT(*) AS n FROM poc_findings WHERE status = ?')
    .bindParams('open')
    .execute();
  const n = r.rows[0].n;
  return `Tracewise action reached. Open findings in the database: ${n}.`;
}