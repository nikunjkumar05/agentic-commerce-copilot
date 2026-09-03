/**
 * Demo funnel seeder: produces the measured revenue number for the pitch.
 *
 * Creates an ISOLATED demo merchant (demo-funnel@agentic-copilot.local) with:
 *   - 3 demo products, 1 campaign, 10 suggested upsell invoices (drafts),
 *   - 3 accepted (validated), 0 paid.
 * Paid is DELIBERATELY left at 0: only a real Razorpay test-mode payment
 * (Payment Link or mandate capture → webhook) may increment it. Pay one of the
 * printed invoices, re-run with --report, and watch paid tick to 1.
 *
 * Every seeded row is labeled DEMO in its audit details. Run against your own
 * Neon branch, never prod. Idempotent: re-runs reuse the demo user/products.
 *
 * Usage:
 *   node scripts/demo_funnel.mjs            # seed (or top-up to 10/3/0)
 *   node scripts/demo_funnel.mjs --report   # print funnel JSON only
 */
import 'dotenv/config';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../api/_db.js';

// NOTE: api/index.js is deliberately NOT imported — it boots the HTTP server
// and seeds demo auth users on import. This script needs only the ledger math,
// replicated here (same canonical V2 payload as appendAuditLog).
const canonAmount = (v) => (v || null) === null ? null : Number(v);
async function appendAudit(userId, data) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const last = await client.query(
      'SELECT hash FROM audit_logs WHERE user_id = $1 ORDER BY sequence_num DESC, created_date DESC LIMIT 1', [userId]);
    const prev = last.rows[0]?.hash || '0'.repeat(64);
    const ts = new Date().toISOString();
    const ins = await client.query(
      `INSERT INTO audit_logs (id, user_id, action, invoice_id, invoice_number, amount, tx_hash, details, created_date, prev_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, sequence_num`,
      [uuidv4(), userId, data.action, data.invoice_id || null, data.invoice_number || null,
       canonAmount(data.amount), data.tx_hash || null, data.details || null, ts, prev]);
    const hash = crypto.createHash('sha256').update(JSON.stringify({
      user_id: userId, sequence_num: Number(ins.rows[0].sequence_num), action: data.action,
      invoice_id: data.invoice_id || null, invoice_number: data.invoice_number || null,
      amount: canonAmount(data.amount), agent_address: null, owner_address: null,
      tx_hash: data.tx_hash || null, details: data.details || null, prev_hash: prev, timestamp: ts,
    })).digest('hex');
    await client.query('UPDATE audit_logs SET hash = $1 WHERE id = $2', [hash, ins.rows[0].id]);
  });
}

const REPORT_ONLY = process.argv.includes('--report');
const EMAIL = 'demo-funnel@agentic-copilot.local';

async function ensureDemoUser() {
  const existing = await query('SELECT id FROM users WHERE email = $1', [EMAIL]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = uuidv4();
  await query(
    `INSERT INTO users (id, email, password, name, role, is_verified, agent_delegation_max, agent_daily_limit, agent_daily_spent)
     VALUES ($1, $2, $3, $4, 'merchant', 1, 50000, 50000, 0)`,
    [id, EMAIL, bcrypt.hashSync(uuidv4(), 10), 'Demo Funnel Merchant']
  );
  return id;
}

if (!REPORT_ONLY) {
  const userId = await ensureDemoUser();

  // Products (idempotent by sku)
  const skus = [
    ['demo-seed-base', 'Demo Base Server', 20000, 16000],
    ['demo-seed-addon', 'Demo Backup Add-on', 8000, 6000],
    ['demo-seed-care', 'Demo Care Plan', 5000, 4000],
  ];
  for (const [sku, name, price, floor] of skus) {
    await query(
      `INSERT INTO products (id, user_id, sku, name, description, price, margin_floor, hsn_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '998433')
       ON CONFLICT DO NOTHING`,
      [uuidv4(), userId, sku, name, 'DEMO seed product for funnel measurement', price, floor]
    );
  }

  // Campaign (idempotent by name)
  let camp = await query('SELECT id FROM campaigns WHERE user_id = $1 AND name = $2', [userId, 'DEMO funnel campaign']);
  let campId;
  if (camp.rows[0]) {
    campId = camp.rows[0].id;
  } else {
    campId = uuidv4();
    await query(
      `INSERT INTO campaigns (id, user_id, name, target_status, upsell_product_id, budget_cap, status)
       VALUES ($1, $2, 'DEMO funnel campaign', 'validated', 'demo-seed-addon', 50000, 'launched')`,
      [campId, userId]
    );
    await appendAudit(userId, { action: 'campaign_launched', details: 'DEMO seed: funnel campaign launched for measurement.' });
  }

  // Top up to 10 suggested drafts, 3 accepted
  const have = await query(`SELECT COUNT(*)::int AS c FROM invoices WHERE user_id = $1 AND campaign_id = $2`, [userId, campId]);
  for (let i = have.rows[0].c; i < 10; i++) {
    const invId = uuidv4();
    const invNo = `DEMO-${1000 + i}`;
    const subtotal = 8000, tax = 1440, grand = 9440;
    const status = i < 3 ? 'validated' : 'draft';
    await query(
      `INSERT INTO invoices (id, user_id, invoice_number, institution_name, line_items, subtotal, tax_total,
        grand_total, currency, status, is_ai_upsell, campaign_id, invoice_date, due_date)
       VALUES ($1,$2,$3,'Demo Funnel Merchant',$4,$5,$6,$7,'INR',$8,TRUE,$9,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days')`,
      [invId, userId, invNo,
        JSON.stringify([{ sku: 'demo-seed-addon', description: 'Demo Backup Add-on', quantity: 1, unit_price: 8000, tax_rate: 18, total: 8000 }]),
        subtotal, tax, grand, status, campId]
    );
    await appendAudit(userId, {
      action: 'campaign_converted', invoice_id: invId, invoice_number: invNo, amount: grand,
      details: 'DEMO seed: upsell suggested by funnel campaign.',
    });
  }
  await query(`UPDATE campaigns SET sent = 10, accepted = 3 WHERE id = $1`, [campId]);
  console.log('[demo] seeded: 10 suggested, 3 accepted, 0 paid (pay a DEMO invoice in test mode to move paid).');
}

// Report (same math as GET /api/growth/funnel)
const userId = (await query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0]?.id;
if (!userId) { console.log(JSON.stringify({ suggested: 0, accepted: 0, paid: 0 })); process.exit(0); }
const [s, camp] = await Promise.all([
  query(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE user_id = $1 AND action IN ('campaign_converted','upsell_suggested','campaign_launched')`, [userId]),
  query(`SELECT COALESCE(SUM(accepted),0)::int AS a, COALESCE(SUM(paid),0)::int AS p FROM campaigns WHERE user_id = $1`, [userId]),
]);
const funnel = {
  suggested: s.rows[0].c, accepted: camp.rows[0].a, paid: camp.rows[0].p,
  accept_rate: s.rows[0].c ? Number((camp.rows[0].a / s.rows[0].c).toFixed(3)) : null,
  note: 'DEMO data on an isolated demo merchant. Paid moves only via real Razorpay test-mode settlement.',
};
console.log(JSON.stringify(funnel, null, 2));
process.exit(0);
