/**
 * One-time migration: rewrite legacy (V1) audit-log hashes to the canonical V2 format.
 *
 * Background: early rows were hashed over a 4-field subset
 *   {action, details, prev_hash, timestamp}
 * while current rows hash the full row including sequence_num and all
 * nullable fields. The verifier accepts both, but a legacy DB shows a mixed
 * chain. This script rewrites each user's chain forward in (sequence_num,
 * created_date, id) order so every row validates as V2.
 *
 * Safety:
 *  - Dry-run by default. Pass --apply to write.
 *  - Per-user transaction: any genuinely broken link (neither V1 nor V2 chain
 *    validates, i.e. real tampering) aborts that user with a report — the
 *    script never rewrites evidence of tampering.
 *  - Amounts are canonicalized (NUMERIC comes back as "5000.00", hashed as 5000).
 *
 * Usage:
 *   node scripts/backfill_audit_hashes.mjs            # dry-run report
 *   node scripts/backfill_audit_hashes.mjs --apply    # rewrite + verify
 */
import 'dotenv/config';
import crypto from 'crypto';
import { query, withTransaction } from '../api/_db.js';

const APPLY = process.argv.includes('--apply');
const GENESIS = '0'.repeat(64);

const toUtcIso = (ts) => {
  if (!ts) return ts;
  let s = String(ts).replace(' ', 'T');
  const dot = s.indexOf('.');
  if (dot === -1) s += '.000';
  else s = s.slice(0, dot + 1) + s.slice(dot + 1).padEnd(3, '0').slice(0, 3);
  return s + 'Z';
};
const canonAmount = (v) => (v || null) === null ? null : Number(v);

const v2Payload = (log, prevHash) => JSON.stringify({
  user_id: log.user_id,
  sequence_num: Number(log.sequence_num),
  action: log.action,
  invoice_id: log.invoice_id || null,
  invoice_number: log.invoice_number || null,
  amount: canonAmount(log.amount),
  agent_address: log.agent_address || null,
  owner_address: log.owner_address || null,
  tx_hash: log.tx_hash || null,
  details: log.details || null,
  prev_hash: prevHash,
  timestamp: toUtcIso(log.created_ts),
});
const v1Payload = (log, prevHash) => JSON.stringify({
  action: log.action,
  details: log.details || null,
  prev_hash: prevHash,
  timestamp: toUtcIso(log.created_ts),
});
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const users = (await query('SELECT DISTINCT user_id FROM audit_logs')).rows.map(r => r.user_id);
console.log(`[backfill] ${users.length} user chain(s). Mode: ${APPLY ? 'APPLY' : 'dry-run'}`);

const report = { users: users.length, already_v2: 0, migrated: 0, broken: [] };

for (const userId of users) {
  const { rows } = await query(
    `SELECT id, user_id, action, invoice_id, invoice_number, amount, agent_address,
            owner_address, tx_hash, details, prev_hash, hash, sequence_num,
            created_date::text AS created_ts
     FROM audit_logs WHERE user_id = $1
     ORDER BY sequence_num ASC NULLS FIRST, created_date ASC, id ASC`,
    [userId]
  );
  // Classify the existing chain without touching it
  let prev = GENESIS, needsMigration = false, brokenId = null;
  for (const log of rows) {
    if (log.prev_hash !== prev) { brokenId = log.id; break; }
    const okV2 = log.hash === sha(v2Payload(log, prev));
    const okV1 = log.hash === sha(v1Payload(log, prev));
    if (!okV2 && !okV1) { brokenId = log.id; break; }
    if (!okV2) needsMigration = true;
    prev = log.hash;
  }
  if (brokenId) {
    report.broken.push({ user_id: userId, broken_log_id: brokenId });
    console.log(`[backfill] user ${userId}: REFUSED — chain broken at ${brokenId} (possible tampering, left untouched)`);
    continue;
  }
  if (!needsMigration) {
    report.already_v2++;
    console.log(`[backfill] user ${userId}: already V2 (${rows.length} rows)`);
    continue;
  }
  if (!APPLY) {
    console.log(`[backfill] user ${userId}: WOULD migrate ${rows.length} rows (dry-run)`);
    continue;
  }
  await withTransaction(async (client) => {
    let p = GENESIS;
    for (const log of rows) {
      const h = sha(v2Payload(log, p));
      await client.query('UPDATE audit_logs SET prev_hash = $1, hash = $2 WHERE id = $3', [p, h, log.id]);
      p = h;
    }
  });
  report.migrated++;
  console.log(`[backfill] user ${userId}: migrated ${rows.length} rows to V2`);
}

console.log('[backfill] report:', JSON.stringify(report, null, 2));
process.exit(report.broken.length > 0 ? 2 : 0);
