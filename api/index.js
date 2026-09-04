import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, initDb, withTransaction } from './_db.js';
import { generateToken, authMiddleware } from './_auth.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

import 'express-async-errors';

const app = express();

// Canonical ledger number: node-postgres returns NUMERIC(12,2) as a string
// ("5000.00") while callers pass JS numbers (5000). Both must hash identically,
// or verification would false-flag every row with an amount. `||` semantics
// are preserved (0 and '' both map to null, exactly as before).
const canonLedgerAmount = (v) => (v || null) === null ? null : Number(v);

export async function appendAuditLog(userId, data) {
  const id = uuidv4();
  return await withTransaction(async (client) => {
    // Acquire transaction-scoped advisory lock for this user to serialize hash chain writes
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

    // 1. Get previous hash for the chain
    const lastLog = await client.query(
      'SELECT hash FROM audit_logs WHERE user_id = $1 ORDER BY sequence_num DESC, created_date DESC LIMIT 1',
      [userId]
    );
    const prev_hash = lastLog.rows.length > 0 && lastLog.rows[0].hash ? lastLog.rows[0].hash : '0'.repeat(64);
    const timestamp = data.created_date || new Date().toISOString();

    // 2. Insert row to get the auto-generated sequence_num
    const insertRes = await client.query(`
      INSERT INTO audit_logs (id, user_id, action, invoice_id, invoice_number, amount,
        agent_address, owner_address, tx_hash, details, created_date, prev_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING sequence_num
    `, [
      id, userId, data.action, data.invoice_id || null, data.invoice_number || null,
      data.amount || null, data.agent_address || null, data.owner_address || null, data.tx_hash || null, data.details || null,
      timestamp, prev_hash
    ]);

    const seq = insertRes.rows[0].sequence_num;

    // 3. Compute full canonical SHA-256 over ALL fields to prevent tampering
    const payload = JSON.stringify({
      user_id: userId,
      sequence_num: Number(seq),
      action: data.action,
      invoice_id: data.invoice_id || null,
      invoice_number: data.invoice_number || null,
      amount: canonLedgerAmount(data.amount),
      agent_address: data.agent_address || null,
      owner_address: data.owner_address || null,
      tx_hash: data.tx_hash || null,
      details: data.details || null,
      prev_hash: prev_hash,
      timestamp: timestamp
    });
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    // 4. Store hash
    await client.query('UPDATE audit_logs SET hash = $1 WHERE id = $2', [hash, id]);

    return id;
  });
}

app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Id'] }));
// Keep the RAW request body so webhook HMAC verification runs over the exact
// bytes Razorpay signed (re-stringifying parsed JSON is not byte-identical).
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// 5 autonomous settlements per minute per user — prevents agent stampedes
// even if the gate logic is bypassed. Tracked by req.user.id (auth required).
const agentSettleRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || 'unauthenticated',
  handler: async (req, res) => {
    try {
      if (req.user?.id) {
        await appendAuditLog(req.user.id, {
          action: 'rate_limit_hit',
          details: 'Agent settlement rate limit exceeded (>5/min). Request rejected.'
        });
      }
    } catch { /* ledger write must not crash the 429 */ }
    res.status(429).json({
      error: 'rate_limited',
      message: 'Too many autonomous settlement attempts. Slow down or escalate to a human.'
    });
  }
});

// b2b-buy is the buyer's first leg. It's idempotent by product_id+user but
// we still cap to 10/min to prevent 402 spam against the merchant.
const agentBuyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || 'unauthenticated',
  handler: (req, res) => res.status(429).json({
    error: 'rate_limited',
    message: 'Too many b2b-buy attempts. Slow down.'
  })
});

/**
 * Enforce the per-transaction and per-day budget. Returns null if OK,
 * otherwise a {status, body} response describing the breach. The caller MUST
 * return that response (do not throw). The check is wrapped in a SQL
 * transaction so two concurrent settle calls cannot both spend the daily cap.
 */
async function enforceMandate(invoice) {
  // A CFO-issued Buyer Mandate checked deterministically. 
  // In a real multi-tenant app, this would be fetched via `buyer_id` or `did:web:`.
  // Here we use a global deterministic policy to replace the arbitrary compliance_score.
  const mandate = {
    sku_allowlist: ['prod_it_license', 'prod_m365', 'prod_webex', 'prod_cloud_hosting', 'prod_cdn', 'prod_backup', 'prod_gst_filing', 'prod_audit', 'prod_esign'],
    new_vendor: false
  };

  let lineItems = invoice.line_items || [];
  if (typeof lineItems === 'string') {
    try { lineItems = JSON.parse(lineItems); } catch { lineItems = []; }
  }
  
  for (const item of lineItems) {
    let sku = item.sku;
    if (!sku && AGENT_CATALOG?.catalog) {
      const desc = (item.description || '').toLowerCase();
      const matched = AGENT_CATALOG.catalog.find(p => 
        desc.includes(p.name.toLowerCase()) || desc.includes(p.id.toLowerCase())
      );
      if (matched) sku = matched.id;
    }

    if (!sku || !mandate.sku_allowlist.includes(sku)) {
      return {
        status: 403,
        body: {
          error: 'agent_out_of_bounds',
          reason: 'sku_not_in_mandate',
          message: `SKU '${sku || item.description || 'UNKNOWN'}' is not in the buyer's approved mandate allowlist.`,
        },
        audit: {
          action: 'settlement_blocked',
          amount: invoice.grand_total,
          details: `Blocked: SKU '${sku || item.description}' not in mandate allowlist.`,
        }
      };
    }
  }

  return null; // Passes the mandate
}

async function enforceBudget(userId, amount, delegation_max) {
  const numAmount = Number(amount) || 0;
  const numDelegationMax = Number(delegation_max) || 0;
  const today = new Date().toISOString().slice(0, 10);
  
  // Auto-reset the daily counter at midnight
  await query(
    'UPDATE users SET agent_daily_spent = 0, daily_reset_date = $1 WHERE id = $2 AND daily_reset_date IS DISTINCT FROM $1',
    [today, userId]
  );

  if (numDelegationMax > 0 && numAmount > numDelegationMax) {
    return {
      status: 403,
      body: {
        error: 'budget_exceeded',
        reason: 'per_transaction',
        message: `Transaction ₹${numAmount.toFixed(2)} exceeds autonomous per-transaction delegation ₹${numDelegationMax.toFixed(2)}.`,
      },
      audit: {
        action: 'settlement_blocked',
        amount: numAmount,
        details: `Blocked: ₹${numAmount} > per-transaction delegation ₹${numDelegationMax}.`,
      }
    };
  }

  // Atomic Reservation: bump the counter ONLY if it won't exceed the limit
  const reserveRes = await query(
    `UPDATE users 
     SET agent_daily_spent = agent_daily_spent + $1 
     WHERE id = $2 AND (agent_daily_limit = 0 OR agent_daily_spent + $1 <= agent_daily_limit) 
     RETURNING agent_daily_limit, agent_daily_spent`,
    [numAmount, userId]
  );

  if (reserveRes.rowCount === 0) {
    // The atomic update failed because it would exceed the limit.
    // Fetch the actual current values to return a good error message.
    const uRes = await query('SELECT agent_daily_limit, agent_daily_spent FROM users WHERE id = $1', [userId]);
    const dailyLimit = Number(uRes.rows[0]?.agent_daily_limit || 0);
    const dailySpent = Number(uRes.rows[0]?.agent_daily_spent || 0);
    
    return {
      status: 403,
      body: {
        error: 'budget_exceeded',
        reason: 'daily_limit',
        message: `Daily autonomous spend limit (₹${dailyLimit}) would be exceeded: already ₹${dailySpent}, requested ₹${amount}.`,
        daily_limit: dailyLimit,
        daily_spent: dailySpent,
      },
      audit: {
        action: 'settlement_blocked',
        amount,
        details: `Blocked: daily limit ₹${dailyLimit}, already spent ₹${dailySpent}, requested ₹${amount}.`,
      }
    };
  }

  return null;
}

/** Refund a previously-reserved amount back to the daily counter (used on error). */
async function refundBudget(userId, amount) {
  try {
    await query(
      'UPDATE users SET agent_daily_spent = GREATEST(agent_daily_spent - $1, 0) WHERE id = $2',
      [Number(amount) || 0, userId]
    );
  } catch (e) {
    console.error('[BUDGET] refund failed:', e?.message);
  }
}

/**
 * Closed-loop campaign attribution: when an invoice tied to a campaign moves
 * to a more-advanced state, increment the corresponding counter exactly once
 * per invoice. The campaign_events PK (invoice_id, kind) is the idempotency
 * key — replays, dual webhook events, and repeated PUTs are all noops.
 */
async function bumpCampaignForInvoice(invoiceId, kind) {
  if (!invoiceId) return;
  try {
    const claimed = await query(
      `INSERT INTO campaign_events (invoice_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING invoice_id`,
      [invoiceId, kind]
    );
    if (claimed.rows.length === 0) return; // already counted for this invoice
    if (kind === 'accepted') {
      // Draft → validated: customer accepted the upsell offer
      await query(
        `UPDATE campaigns SET accepted = accepted + 1
         WHERE id = (SELECT campaign_id FROM invoices WHERE id = $1)
           AND (SELECT campaign_id FROM invoices WHERE id = $1) IS NOT NULL`,
        [invoiceId]
      );
    } else if (kind === 'paid') {
      // Any → paid: the upsell converted to revenue
      await query(
        `UPDATE campaigns SET paid = paid + 1
         WHERE id = (SELECT campaign_id FROM invoices WHERE id = $1)
           AND (SELECT campaign_id FROM invoices WHERE id = $1) IS NOT NULL`,
        [invoiceId]
      );
      await appendAuditLog((await query('SELECT user_id FROM invoices WHERE id = $1', [invoiceId])).rows[0]?.user_id, {
        action: 'campaign_converted_revenue',
        invoice_id: invoiceId,
        details: 'Campaign-generated invoice paid — campaign.paid counter incremented.'
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[CAMPAIGN] bump failed (non-fatal):', e?.message);
  }
}

async function seedDemoData(userId) {
  // Disabled by agent: user requested all invoices be permanently removed.
  return;
  
  const now = new Date();
  const count = await query('SELECT COUNT(*)::int AS c FROM invoices WHERE user_id = $1', [userId]);
  // NOTE: demo seed data. No fake IPFS CIDs or fake tx hashes — those fields
  // stay empty until a REAL IPFS upload (Lighthouse) or Razorpay payment fills them.
  const invoices = [
    { invNo: 'INV-2026-1001', name: 'Delhi Jal Board', recipient: 'NDMC', amount: 125000, status: 'paid', date: new Date(now.getTime() - 2*86400000) },
    { invNo: 'INV-2026-1002', name: 'BSES Yamuna Power Ltd', recipient: 'South Delhi MCD', amount: 89000, status: 'validated', date: new Date(now.getTime() - 5*86400000) },
    { invNo: 'INV-2026-1003', name: 'Delhi Transport Corp', recipient: 'DTC Headquarters', amount: 245000, status: 'draft', date: new Date(now.getTime() - 7*86400000) },
    { invNo: 'INV-2026-1004', name: 'PWD Delhi', recipient: 'CPWD', amount: 567000, status: 'stored', date: new Date(now.getTime() - 12*86400000) },
    { invNo: 'INV-2026-1005', name: 'Delhi Police HQs', recipient: 'MHA', amount: 340000, status: 'paid', date: new Date(now.getTime() - 15*86400000) },
    { invNo: 'INV-2026-1006', name: 'NDMC', recipient: 'New Delhi Municipal Council', amount: 78000, status: 'anomaly', date: new Date(now.getTime() - 20*86400000), score: 45 },
    { invNo: 'INV-2026-1007', name: 'Delhi Metro Rail Corp', recipient: 'DMRC', amount: 980000, status: 'validated', date: new Date(now.getTime() - 25*86400000) },
    
    // AI Upsell Seed Data
    { invNo: 'INV-2026-U001', name: 'Acme Corp', recipient: 'Acme Corp', amount: 13500, status: 'paid', date: new Date(now.getTime() - 1*86400000), is_ai_upsell: true },
    { invNo: 'INV-2026-U002', name: 'Globex Inc', recipient: 'Globex Inc', amount: 15500, status: 'paid', date: new Date(now.getTime() - 4*86400000), is_ai_upsell: true },
    { invNo: 'INV-2026-U003', name: 'Initech', recipient: 'Initech', amount: 9500, status: 'paid', date: new Date(now.getTime() - 10*86400000), is_ai_upsell: true },
    { invNo: 'INV-2026-U004', name: 'Soylent Corp', recipient: 'Soylent Corp', amount: 23500, status: 'validated', date: new Date(now.getTime() - 14*86400000), is_ai_upsell: true },
  ];

  for (const inv of invoices) {
    let items, subtotal;
    if (inv.is_ai_upsell) {
      items = [
        { description: 'Base Subscription', quantity: 1, unit_price: Math.round(inv.amount * 0.7 / 1.18), tax_rate: 18, total: Math.round(inv.amount * 0.7 / 1.18) },
        { description: 'Agent Recommended Upsell', quantity: 1, unit_price: Math.round(inv.amount * 0.3 / 1.18), tax_rate: 18, total: Math.round(inv.amount * 0.3 / 1.18) }
      ];
      subtotal = items[0].unit_price + items[1].unit_price;
    } else {
      items = [
        { description: 'Consulting Services', quantity: 5, unit_price: 15000, tax_rate: 18, total: 75000 },
        { description: 'Software License', quantity: 2, unit_price: 25000, tax_rate: 18, total: 50000 },
      ];
      subtotal = 125000;
    }
    
    const tax_total = Math.round(subtotal * 0.18);
    const grand_total = subtotal + tax_total;
    await query(`
      INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address, gst_number,
        recipient_name, recipient_address, recipient_gst, line_items, subtotal, tax_total, grand_total,
        currency, status, compliance_score, ai_suggestions, is_ai_upsell, invoice_date, due_date, cid, tx_hash, created_date, updated_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    `, [
      uuidv4(), userId, inv.invNo,
      inv.name, `${inv.name}, Delhi`, '07AAACN0372J1ZB',
      inv.recipient, `${inv.recipient}, New Delhi`, '07BBBCD0483K2ZC',
      JSON.stringify(items), subtotal, tax_total, grand_total,
      'INR', inv.status, inv.score || 85,
      JSON.stringify([{ field: 'gst', severity: 'info', issue: 'GST verified', suggestion: 'All GST numbers valid' }]),
      inv.is_ai_upsell || false,
      inv.date.toISOString().split('T')[0],
      new Date(inv.date.getTime() + 30*86400000).toISOString().split('T')[0],
      inv.cid || null, inv.tx || null,
      inv.date.toISOString(), inv.date.toISOString(),
    ]);
  }

  const auditActions = [
    { action: 'settlement', invNo: 'INV-2026-1001', amount: 125000, tx: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    { action: 'validation', invNo: 'INV-2026-1002', amount: 89000 },
    { action: 'delegation_created', amount: 500000 },
    { action: 'settlement', invNo: 'INV-2026-1005', amount: 340000, tx: '0x1111111111111111111111111111111111111111111111111111111111111111' },
    { action: 'delegation_revoked' },
  ];

  for (const log of auditActions) {
    await appendAuditLog(userId, {
      action: log.action,
      invoice_number: log.invNo,
      amount: log.amount,
      tx_hash: log.tx,
      details: `${log.action} processed for invoice ${log.invNo || 'N/A'}`,
      created_date: new Date(now.getTime() - Math.random()*30*86400000).toISOString()
    });
  }

  console.log('Demo data seeded');
}

let seedingDone = false;
async function ensureSeeded() {
  if (seedingDone) return;
  try {
    await initDb();
    const existing = await query('SELECT id FROM users WHERE email = $1', ['user@gmail.com']);
    if (existing.rows.length === 0) {
      const userId = uuidv4();
      const hashed = bcrypt.hashSync('123456', 10);
      await query(
        'INSERT INTO users (id, email, password, name, role, is_verified) VALUES ($1, $2, $3, $4, $5, 1)',
        [userId, 'user@gmail.com', hashed, 'Demo User', 'user']
      );
      await seedDemoData(userId);
    } else {
      await seedDemoData(existing.rows[0].id);
    }
    seedingDone = true;
  } catch (err) {
    if (err?.type !== 'error') {
      console.warn('[DB] Init notice (will retry on next request):', err?.message || err);
    }
  }
}
ensureSeeded();

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Interop: UAP + ACP + AP2 discovery ---
// Real protocol implementations (UAP, ACP, AP2) are out of scope for a
// weekend build. We publish honest, stable, well-formed discovery documents
// so external agents can find the merchant and the offered payment rails
// without us pretending to implement the full spec. The x402 implementation
// is the live one; these are the "address-book" surface area.

// Universal Agent Protocol (UAP) — discovery + capability advertisement
app.get('/.well-known/uap.json', (req, res) => {
  res.json({
    protocol: 'uap/0.1',
    merchant: {
      did: 'did:web:agentic-commerce.local',
      name: 'Agentic Commerce Co-Pilot',
      type: 'B2B IT Services & Licensing',
      currency: 'INR',
    },
    capabilities: {
      search_catalog: { endpoint: '/api/catalog', method: 'GET', auth: 'none' },
      quote: { endpoint: '/api/agent/b2b-buy', method: 'POST', auth: 'bearer' },
      pay: { endpoint: '/api/agent/b2b-pay', method: 'POST', auth: 'bearer', protocol: 'x402_razorpay' },
    },
    payment_rails: [
      { id: 'x402_razorpay', status: 'live' },
      { id: 'ap2_cart_mandate', status: 'planned' },
      { id: 'acp_checkout', status: 'planned' },
    ],
  });
});

// Agentic Commerce Protocol (ACP) — product feed for buyer agents
app.get('/.well-known/acp/feed.json', (req, res) => {
  res.json({
    protocol: 'acp/0.1',
    merchant_id: 'did:web:agentic-commerce.local',
    currency: 'INR',
    catalog_url: '/.well-known/agent-catalog.json',
    checkout_url: '/api/agent/b2b-buy',
    note: 'This is a discovery document. The product feed is reused from /api/agent/chat → agent-catalog.json.',
  });
});

// AP2 (Agent Payments Protocol) — cart-mandate endpoint placeholder.
// AP2 mandates are signed carts the buyer agent sends; we acknowledge the
// shape but do not yet verify signatures end-to-end.
app.post('/ap2/cart-mandate', authMiddleware, async (req, res) => {
  await appendAuditLog(req.user.id, {
    action: 'ap2_mandate_received',
    details: `AP2 cart-mandate received (${req.body?.items?.length || 0} items). Full AP2 signature verification is planned; payload was acknowledged and logged.`,
  });
  res.status(202).json({
    accepted: true,
    protocol: 'ap2/0.1',
    message: 'Cart mandate acknowledged. Use /api/agent/b2b-buy to convert to a payment challenge.',
  });
});

// --- Auth ---
const registerSchema = z.object({ email: z.string().email(), password: z.string().min(6), role: z.string().optional() });
const loginSchema = z.object({ email: z.string().email(), password: z.string(), role: z.string().optional() });
const verifyOtpSchema = z.object({ email: z.string().email(), otp: z.string().min(4).max(8) });

app.post('/api/auth/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation_error', message: parsed.error.errors[0].message });

    const { email, password, role } = parsed.data;
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'email_exists', message: 'Email already registered' });

    const id = uuidv4();
    const hashed = bcrypt.hashSync(password, 10);
    const userRole = (role === 'buyer' || role === 'merchant') ? role : 'user';
    await query(
      'INSERT INTO users (id, email, password, name, is_verified, role) VALUES ($1, $2, $3, $4, 0, $5)',
      [id, email, hashed, email.split('@')[0], userRole]
    );

    // Generate 6-digit OTP via CSPRNG (Math.random is predictable)
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHashed = bcrypt.hashSync(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min expiry

    await query(`
      INSERT INTO user_otps (email, otp_hash, attempts, expires_at, created_at)
      VALUES ($1, $2, 0, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET otp_hash = $2, attempts = 0, expires_at = $3, created_at = NOW()
    `, [email, otpHashed, expiresAt]);

    console.log(`[AUTH] Verification OTP generated for ${email}: ${otp}`);

    res.json({
      success: true,
      message: 'Verification code sent to email',
      // Explicit opt-in only: NODE_ENV is rarely "production" in demos, which
      // used to leak OTPs in-band by default.
      ...(process.env.ALLOW_DEV_OTP === '1' ? { dev_otp: otp } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const parsed = verifyOtpSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation_error', message: parsed.error.errors[0].message });

    const { email, otp } = parsed.data;

    const userRes = await query('SELECT id, email, name, role FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'User not found' });
    const user = userRes.rows[0];

    const otpRes = await query(
      'SELECT otp_hash, attempts, expires_at FROM user_otps WHERE email = $1',
      [email]
    );

    if (otpRes.rows.length === 0) {
      return res.status(400).json({ error: 'otp_not_found', message: 'No OTP requested for this email. Please request a new code.' });
    }

    const { otp_hash, attempts, expires_at } = otpRes.rows[0];

    if (new Date() > new Date(expires_at)) {
      return res.status(400).json({ error: 'otp_expired', message: 'OTP has expired. Please request a new one.' });
    }

    if (Number(attempts) >= 5) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many incorrect attempts. Please request a new code.' });
    }

    // Atomic attempt gate: a single statement so parallel guesses cannot
    // jointly overshoot the 5-try cap (read-then-increment would race).
    const gate = await query(
      'UPDATE user_otps SET attempts = attempts + 1 WHERE email = $1 AND attempts < 5 RETURNING attempts',
      [email]
    );
    if (gate.rows.length === 0) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const isValid = bcrypt.compareSync(otp, otp_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'invalid_otp', message: 'Invalid verification code' });
    }

    // OTP verified: clear OTP and activate user
    await query('DELETE FROM user_otps WHERE email = $1', [email]);
    await query('UPDATE users SET is_verified = 1, updated_at = NOW() WHERE email = $1', [email]);

    const token = generateToken(user);
    res.json({ access_token: token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'validation_error', message: 'Email required' });

    const userRes = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'User not found' });

    // Rate-limit resend: require 30 seconds between requests. Enforced with a
    // single atomic statement so concurrent resends cannot both slip through
    // a read-then-write gap. The stamp refresh reserves the slot; the real OTP
    // upsert below overwrites it (never touches the stored hash here).
    const slot = await query(
      `UPDATE user_otps SET created_at = NOW()
       WHERE email = $1 AND created_at < NOW() - INTERVAL '30 seconds'
       RETURNING email`,
      [email]
    );
    // Row exists but was touched <30s ago → throttled (unless there is no row
    // at all, which falls through to the insert below).
    const rowExists = (await query('SELECT 1 FROM user_otps WHERE email = $1', [email])).rows.length > 0;
    if (rowExists && slot.rows.length === 0) {
      return res.status(429).json({ error: 'rate_limited', message: 'Please wait 30 seconds before requesting another code.' });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHashed = bcrypt.hashSync(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await query(`
      INSERT INTO user_otps (email, otp_hash, attempts, expires_at, created_at)
      VALUES ($1, $2, 0, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET otp_hash = $2, attempts = 0, expires_at = $3, created_at = NOW()
    `, [email, otpHashed, expiresAt]);

    console.log(`[AUTH] Resent OTP for ${email}: ${otp}`);

    res.json({
      success: true,
      message: 'New verification code sent',
      ...(process.env.ALLOW_DEV_OTP === '1' ? { dev_otp: otp } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation_error', message: parsed.error.errors[0].message });

    const { email, password, role } = parsed.data;
    const userRes = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid credentials' });

    const user = userRes.rows[0];
    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid credentials' });
    
    // For the hackathon demo, automatically update their role to whatever they selected at login
    let updatedRole = user.role;
    if (role && (role === 'buyer' || role === 'merchant') && user.role !== role) {
      await query('UPDATE users SET role = $1 WHERE id = $2', [role, user.id]);
      updatedRole = role;
      user.role = role;
    }

    const token = generateToken(user);
    res.json({ access_token: token, user: { id: user.id, email: user.email, name: user.name, role: updatedRole } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/demo', async (req, res) => {
  try {
    const email = 'demo@razorpay.hackathon';
    let result = await query('SELECT * FROM users WHERE email = $1', [email]);
    let user;
    
    if (result.rows.length === 0) {
      const id = uuidv4();
      const hashed = bcrypt.hashSync('demo123', 10);
      await query(
        'INSERT INTO users (id, email, password, name, is_verified) VALUES ($1, $2, $3, $4, 1)',
        [id, email, hashed, 'Demo Judge']
      );
      result = await query('SELECT * FROM users WHERE email = $1', [email]);
    }
    user = result.rows[0];
    
    await seedDemoData(user.id);
    const token = generateToken(user);
    res.json({ access_token: token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Demo mode failed' });
  }
});

app.post('/api/auth/forgot-password', (req, res) => res.json({ success: true }));
app.post('/api/auth/reset-password', (req, res) => res.json({ success: true }));

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const result = await query(
    'SELECT id, email, name, role, created_at, agent_delegation_max, agent_daily_limit, agent_daily_spent, daily_reset_date, razorpay_customer_id, razorpay_token_id FROM users WHERE id = $1',
    [req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'User not found' });
  res.json(result.rows[0]);
});

app.post('/api/auth/logout', (req, res) => res.json({ success: true }));

app.post('/api/auth/vault-test-card', authMiddleware, async (req, res) => {
  // Simulates the end of a Razorpay Tokenization checkout where the frontend
  // receives the token_id and customer_id and hands it to the backend.
  // In a 100% real prod app, you'd extract this from the Razorpay Webhook or Order API.
  const { razorpay_customer_id, razorpay_token_id } = req.body;
  if (!razorpay_customer_id || !razorpay_token_id) {
    return res.status(400).json({ error: 'bad_request', message: 'Missing token data' });
  }

  await query(
    'UPDATE users SET razorpay_customer_id = $1, razorpay_token_id = $2, updated_at = NOW() WHERE id = $3',
    [razorpay_customer_id, razorpay_token_id, req.user.id]
  );
  
  res.json({ success: true, message: 'Card successfully vaulted.' });
});

// --- Invoices ---
const ALLOWED_SORT_FIELDS = new Set([
  'created_date', 'updated_date', 'invoice_date', 'due_date',
  'grand_total', 'subtotal', 'tax_total', 'compliance_score',
  'invoice_number', 'status', 'institution_name', 'recipient_name'
]);

app.get('/api/invoices', authMiddleware, async (req, res) => {
  const raw = req.query.sort || '-created_date';
  const sortField = raw.replace(/^-/, '');
  const dir = raw.startsWith('-') ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const safeField = ALLOWED_SORT_FIELDS.has(sortField) ? sortField : 'created_date';

  const result = await query(
    `SELECT * FROM invoices 
     WHERE (user_id = $1 OR buyer_id = $1 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $1)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $1))
     ORDER BY ${safeField} ${dir} LIMIT $2`,
    [req.user.id, limit]
  );

  res.json(result.rows.map(parseInvoice));
});

app.get('/api/invoices/:id', authMiddleware, async (req, res) => {
  const result = await query(
    `SELECT * FROM invoices 
     WHERE (id = $1 OR invoice_number = $1) 
       AND (user_id = $2 OR buyer_id = $2 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $2)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $2))`,
    [req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  res.json(parseInvoice(result.rows[0]));
});

app.post('/api/invoices', authMiddleware, async (req, res) => {
  const id = uuidv4();
  const data = req.body;

  // Defensive math — same as normalizeInvoiceResponse: never trust client totals.
  // Fixes bug where AgentChat sent grand_total:10000 with line_items total:10000 but subtotal:0 tax:0.
  let lineItems = data.line_items || [];
  if (typeof lineItems === 'string') { try { lineItems = JSON.parse(lineItems); } catch { lineItems = []; } }
  
  let complianceScore = data.compliance_score || null;
  const aiSuggestions = data.ai_suggestions || [];
  // Invoices may only be BORN as draft/validated/pending — `paid`/`processing`
  // require Razorpay proof via /verify, webhooks, or mandate capture.
  const requestedStatus = data.status || 'draft';
  if (['paid', 'processing'].includes(requestedStatus)) {
    return res.status(403).json({
      error: 'manual_settlement_forbidden',
      message: 'Invoices cannot be created with status paid/processing. Settle via Razorpay verification.',
    });
  }
  let status = ['draft', 'validated', 'pending', 'anomaly', 'stored'].includes(requestedStatus) ? requestedStatus : 'draft';

  // --- Strict Server-Side Pricing & Margin Floor Guardrail ---
  const products = await query('SELECT sku, name, margin_floor, price, hsn_code FROM products');
  
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    
    // Fail-closed guard: always resolve against DB catalog by sku OR description
    const dbProduct = item.sku 
      ? products.rows.find(p => p.sku === item.sku)
      : products.rows.find(p => item.description?.toLowerCase().includes(p.name.toLowerCase()));
      
    if (dbProduct) {
      item.sku = dbProduct.sku;
      item.description = dbProduct.name;
      item.hsn_code = dbProduct.hsn_code;
      // Allow negotiation down to margin floor, default to list price
      const requestedPrice = (item.negotiated_price !== undefined && item.negotiated_price !== null)
        ? Number(item.negotiated_price)
        : ((item.unit_price && Number(item.unit_price) > 0) ? Number(item.unit_price) : (Number(item.price) || Number(dbProduct.price)));
      
      if (requestedPrice < dbProduct.margin_floor) {
        return res.status(400).json({ 
          error: 'margin_floor_violation', 
          message: `Price ₹${requestedPrice} for ${dbProduct.name} is below the strict margin floor of ₹${dbProduct.margin_floor}.`
        });
      }
      item.unit_price = requestedPrice;
    } else if (item.sku && AGENT_CATALOG?.catalog) {
      // Static agent catalog fallback: the DB products table may not mirror
      // every machine-readable SKU (e.g. manual fallback cart). Resolve
      // name/price from the static catalog; floor = list price (no discount
      // without a DB-stored floor — fail-safe), so the invoice still carries
      // a real mandate-allowlisted SKU and stays autonomously settlable.
      const staticProduct = AGENT_CATALOG.catalog.find(p => p.id === item.sku);
      if (!staticProduct) {
        return res.status(400).json({ error: 'invalid_sku', message: `Product SKU ${item.sku} not found.` });
      }
      item.description = staticProduct.name;
      item.hsn_code = staticProduct.hsn_code;
      const requestedPrice = item.negotiated_price ?? item.unit_price ?? item.price ?? staticProduct.price;
      if (requestedPrice < staticProduct.price) {
        return res.status(400).json({
          error: 'margin_floor_violation',
          message: `Price ₹${requestedPrice} for ${staticProduct.name} is below the list price of ₹${staticProduct.price} (no DB margin floor stored — discounting disabled).`
        });
      }
      item.unit_price = requestedPrice;
    } else {
      // If we can't find it in the DB, it's an unrecognized SKU or custom item.
      // If it has a SKU, it's explicitly invalid.
      if (item.sku) {
        return res.status(400).json({ error: 'invalid_sku', message: `Product SKU ${item.sku} not found.` });
      }
      // Otherwise, we allow custom non-catalog items without floor logic.
    }
    
    item.quantity = Number(item.quantity ?? item.qty ?? 1);
    item.unit_price = Number(item.unit_price ?? item.price ?? item.rate ?? 0);
    item.tax_rate = Number(item.tax_rate ?? item.taxRate ?? 18);
    // Reject non-finite money math at the door: negatives forge credit,
    // NaN/Infinity mint ₹0 or infinite invoices downstream.
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
      return res.status(400).json({ error: 'invalid_quantity', message: 'Each line item quantity must be an integer between 1 and 1000.' });
    }
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0 || item.unit_price > 99999999.99) {
      return res.status(400).json({ error: 'invalid_price', message: 'Each line item unit_price must be a finite non-negative number.' });
    }
    if (!Number.isFinite(item.tax_rate) || item.tax_rate < 0 || item.tax_rate > 100) {
      return res.status(400).json({ error: 'invalid_tax_rate', message: 'Each line item tax_rate must be between 0 and 100.' });
    }
    item.total = item.quantity * item.unit_price;
  }

  const subtotal = lineItems.reduce((s, it) => s + it.total, 0);
  const tax_total = Math.round(lineItems.reduce((s, it) => s + it.total * (it.tax_rate / 100), 0));
  const grand_total = subtotal + tax_total;

  const today = new Date().toISOString().split('T')[0];
  const dueDefault = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  let buyerId = data.buyer_id || null;
  if (!buyerId && data.recipient_name) {
    try {
      const matched = await query(
        'SELECT id FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1',
        [data.recipient_name.trim()]
      );
      if (matched.rows.length > 0) {
        buyerId = matched.rows[0].id;
      }
    } catch (e) {
      console.warn('Could not resolve buyer_id for invoice:', e.message);
    }
  }

  await query(`
    INSERT INTO invoices (id, user_id, buyer_id, invoice_number, institution_name, institution_address,
      gst_number, recipient_name, recipient_address, recipient_gst, line_items, subtotal,
      tax_total, grand_total, currency, status, compliance_score, ai_suggestions,
      invoice_date, due_date, milestones, is_ai_upsell)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
  `, [
    id, req.user.id, buyerId,
    data.invoice_number || `INV-${Math.floor(Math.random() * 100000)}`,
    data.institution_name || 'Agentic Commerce Co-Pilot', data.institution_address || 'New Delhi, India', data.gst_number || '07AAACN0372J1ZB',
    data.recipient_name || null, data.recipient_address || null, data.recipient_gst || null,
    JSON.stringify(lineItems), subtotal || 0,
    tax_total || 0, grand_total || 0,
    data.currency || 'INR', status,
    complianceScore, JSON.stringify(aiSuggestions),
    data.invoice_date || today, data.due_date || dueDefault, JSON.stringify(data.milestones || []),
    data.is_ai_upsell ? true : false
  ]);

  const result = await query('SELECT * FROM invoices WHERE id = $1', [id]);
  res.status(201).json(parseInvoice(result.rows[0]));
});

app.put('/api/invoices/:id', authMiddleware, async (req, res) => {
  const exists = await query('SELECT id, status AS old_status FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const internalId = exists.rows[0].id;
  const oldStatus = exists.rows[0].old_status;
  const data = req.body;

  // MONEY GATE: invoices may only reach `paid` via verified settlement paths
  // (/api/agent/verify, webhooks, auto-settle mandate capture). Direct PUT to
  // paid (e.g. free-text UTR) would bypass Razorpay proof — refuse loudly.
  if (data.status === 'paid') {
    await appendAuditLog(req.user.id, {
      action: 'settlement_blocked',
      invoice_id: internalId,
      details: 'Blocked direct PUT to status=paid without Razorpay verification. Use /api/agent/verify or webhook settlement.',
    }).catch(() => {});
    return res.status(403).json({
      error: 'manual_settlement_forbidden',
      message: 'Marking an invoice paid requires Razorpay verification (/api/agent/verify) or a verified webhook — direct status updates to paid are forbidden.',
    });
  }
  const sets = [];
  const params = [];
  let i = 1;

  // NOTE: subtotal/tax_total/grand_total are NOT client-writable — they are
  // always recomputed from line_items below. Otherwise an owner could reprice
  // grand_total to ₹1 and settle a ₹17,700 invoice for a rupee.
  const ALLOWED_UPDATE_FIELDS = new Set([
    'invoice_number', 'institution_name', 'institution_address', 'gst_number',
    'recipient_name', 'recipient_address', 'recipient_gst', 'line_items',
    'currency', 'compliance_score',
    'ai_suggestions', 'invoice_date', 'due_date', 'milestones', 'cid',
    'tx_hash', 'payment_method', 'status'
  ]);
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    if (key === 'status' && value === 'paid') continue;
    
    let processedValue = value;
    if (key === 'line_items') {
      const products = await query('SELECT sku, name, margin_floor, price, hsn_code FROM products');
      const items = typeof value === 'string' ? JSON.parse(value) : value;
      for (const item of items) {
        const dbProduct = item.sku 
          ? products.rows.find(p => p.sku === item.sku)
          : products.rows.find(p => item.description?.toLowerCase().includes(p.name.toLowerCase()));
          
        if (dbProduct) {
          item.sku = dbProduct.sku;
          item.description = dbProduct.name;
          item.hsn_code = dbProduct.hsn_code;
          const requestedPrice = (item.negotiated_price !== undefined && item.negotiated_price !== null)
            ? Number(item.negotiated_price)
            : ((item.unit_price && Number(item.unit_price) > 0) ? Number(item.unit_price) : (Number(item.price) || Number(dbProduct.price)));
          
          if (requestedPrice < dbProduct.margin_floor) {
            return res.status(400).json({ 
              error: 'margin_floor_violation', 
              message: `Price ₹${requestedPrice} for ${dbProduct.name} is below the strict margin floor of ₹${dbProduct.margin_floor}.`
            });
          }
          item.unit_price = requestedPrice;
        } else if (item.sku) {
          return res.status(400).json({ error: 'invalid_sku', message: `Product SKU ${item.sku} not found.` });
        }
        item.quantity = Number(item.quantity ?? item.qty ?? 1);
        item.unit_price = Number(item.unit_price ?? item.price ?? item.rate ?? 0);
        item.tax_rate = Number(item.tax_rate ?? item.taxRate ?? 18);
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
          return res.status(400).json({ error: 'invalid_quantity', message: 'Each line item quantity must be an integer between 1 and 1000.' });
        }
        if (!Number.isFinite(item.unit_price) || item.unit_price < 0 || item.unit_price > 99999999.99) {
          return res.status(400).json({ error: 'invalid_price', message: 'Each line item unit_price must be a finite non-negative number.' });
        }
        if (!Number.isFinite(item.tax_rate) || item.tax_rate < 0 || item.tax_rate > 100) {
          return res.status(400).json({ error: 'invalid_tax_rate', message: 'Each line item tax_rate must be between 0 and 100.' });
        }
        item.total = item.quantity * item.unit_price;
      }
      
      // Totals are ALWAYS recomputed server-side — client-sent subtotal/tax/
      // grand_total are ignored entirely (see ALLOWED_UPDATE_FIELDS).
      const calcSubtotal = items.reduce((s, it) => s + it.total, 0);
      const calcTax = Math.round(items.reduce((s, it) => s + it.total * (it.tax_rate / 100), 0));
      const calcGrand = calcSubtotal + calcTax;
      
      processedValue = items;
      // Append the recalculated totals alongside line_items (same statement).
      sets.push(`subtotal = $${i}`); params.push(calcSubtotal); i++;
      sets.push(`tax_total = $${i}`); params.push(calcTax); i++;
      sets.push(`grand_total = $${i}`); params.push(calcGrand); i++;
    }

    if (['line_items', 'ai_suggestions', 'milestones'].includes(key)) {
      sets.push(`${key} = $${i}`);
      params.push(JSON.stringify(processedValue));
    } else {
      sets.push(`${key} = $${i}`);
      params.push(processedValue);
    }
    i++;
  }
  
  // Since compliance_score and status might be injected late by the loop above, check if they exist in data but aren't in sets
  if (data.compliance_score === 0 && !sets.some(s => s.startsWith('compliance_score'))) {
    sets.push(`compliance_score = $${i}`); params.push(0); i++;
    sets.push(`status = $${i}`); params.push('draft'); i++;
    if (data.ai_suggestions && !sets.some(s => s.startsWith('ai_suggestions'))) {
      sets.push(`ai_suggestions = $${i}`); params.push(JSON.stringify(data.ai_suggestions)); i++;
    }
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'No valid fields to update' });
  }
  sets.push(`updated_date = NOW()`);
  params.push(internalId);

  await query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $${i}`, params);
  const result = await query('SELECT * FROM invoices WHERE id = $1', [internalId]);
  const updated = result.rows[0];

  // Closed-loop campaign attribution on genuine TRANSITIONS only (bump itself
  // is per-invoice idempotent, but transition checks keep no-op PUTs quiet).
  if (oldStatus !== 'validated' && updated.status === 'validated') {
    await bumpCampaignForInvoice(internalId, 'accepted');
  }

  res.json(parseInvoice(updated));
});

app.delete('/api/invoices/:id', authMiddleware, async (req, res) => {
  const exists = await query('SELECT id, status FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  // Financial evidence must not be deletable: paid/processing invoices are
  // immutable (funnel joins and audit references would break silently).
  if (['paid', 'processing'].includes(exists.rows[0].status)) {
    return res.status(409).json({ error: 'immutable_invoice', message: `Invoice with status '${exists.rows[0].status}' cannot be deleted.` });
  }
  await query('DELETE FROM invoices WHERE id = $1 AND user_id = $2', [exists.rows[0].id, req.user.id]);
  res.json({ success: true });
});

app.post('/api/ipfs/upload', authMiddleware, async (req, res) => {
  try {
    const LIGHTHOUSE_API_KEY = process.env.LIGHTHOUSE_API_KEY;
    if (!LIGHTHOUSE_API_KEY) {
      throw new Error('LIGHTHOUSE_API_KEY is not set in environment variables');
    }
    const payload = JSON.stringify(req.body, null, 2);
    
    // Dynamic import to avoid breaking top-level if SDK isn't found
    const { default: lighthouse } = await import('@lighthouse-web3/sdk');
    
    const response = await lighthouse.uploadText(payload, LIGHTHOUSE_API_KEY, "invoice.json");
    
    if (!response || !response.data || !response.data.Hash) {
      throw new Error(`Invalid response from Lighthouse SDK`);
    }
    
    const cid = response.data.Hash;
    res.json({ cid: cid, gatewayUrl: `https://gateway.lighthouse.storage/ipfs/${cid}` });
  } catch (err) {
    console.error('IPFS Upload Error:', err.message);
    res.status(500).json({ error: 'ipfs_upload_failed', message: 'Failed to store document on IPFS' });
  }
});

const ALLOWED_AUDIT_SORT_FIELDS = new Set([
  'created_date', 'action', 'amount', 'invoice_number'
]);

// --- Audit Logs ---
app.get('/api/audit-logs', authMiddleware, async (req, res) => {
  const raw = req.query.sort || '-created_date';
  const sortField = raw.replace(/^-/, '');
  const dir = raw.startsWith('-') ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const safeField = ALLOWED_AUDIT_SORT_FIELDS.has(sortField) ? sortField : 'created_date';

  const result = await query(
    `SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY ${safeField} ${dir} LIMIT $2`,
    [req.user.id, limit]
  );
  res.json(result.rows);
});

app.post('/api/audit-logs', authMiddleware, async (req, res) => {
  const data = req.body;
  // FORGE GUARD: settlement/campaign/webhook/ops entries are server-minted.
  // Clients may only write UI-originated actions — anything else would let a
  // user fabricate "settlement_captured" rows that verify cleanly.
  const CLIENT_WRITABLE_ACTIONS = new Set([
    'upsell_suggested', 'manual_reconciliation_claimed', 'milestone_released',
    'delegation_created', 'delegation_revoked',
  ]);
  if (!data || !CLIENT_WRITABLE_ACTIONS.has(data.action)) {
    await appendAuditLog(req.user.id, {
      action: 'settlement_blocked',
      details: `Blocked client attempt to forge ledger action '${data?.action || 'UNKNOWN'}'.`,
    }).catch(() => {});
    return res.status(403).json({
      error: 'ledger_action_forbidden',
      message: `Ledger action '${data?.action || 'UNKNOWN'}' is server-minted and cannot be written by clients.`,
    });
  }
  const id = await appendAuditLog(req.user.id, data);
  const result = await query('SELECT * FROM audit_logs WHERE id = $1', [id]);
  res.status(201).json(result.rows[0]);
});

app.get('/api/audit-logs/verify', authMiddleware, async (req, res) => {
  // Fetch all logs in strict chronological order to verify the chain.
  // created_date::text gives the raw UTC wall-clock that was originally hashed —
  // parsing it as a JS Date would apply the server's timezone (TIMESTAMP WITHOUT
  // TIME ZONE) and break hash recomputation on non-UTC machines.
  const result = await query(
    `SELECT id, user_id, action, invoice_id, invoice_number, amount, agent_address, owner_address, tx_hash, details, prev_hash, hash, sequence_num, created_date::text AS created_ts
     FROM audit_logs WHERE user_id = $1 ORDER BY sequence_num ASC, created_date ASC, id ASC`,
    [req.user.id]
  );

  const logs = result.rows;
  if (logs.length === 0) return res.json({ valid: true, entries_verified: 0, message: 'No logs to verify.' });

  // Reconstruct the exact ISO string the hash was originally computed over:
  // "2026-08-30 20:24:01.311" → "2026-08-30T20:24:01.311Z" (UTC, ms-padded)
  const toUtcIso = (ts) => {
    if (!ts) return ts;
    let s = String(ts).replace(' ', 'T');
    const dot = s.indexOf('.');
    if (dot === -1) s += '.000';
    else s = s.slice(0, dot + 1) + s.slice(dot + 1).padEnd(3, '0').slice(0, 3);
    return s + 'Z';
  };

  let expectedPrevHash = '0'.repeat(64);
  let brokenLogId = null;
  let verified = 0;

  for (const log of logs) {
    // 1. Check if the chain link is intact
    if (log.prev_hash !== expectedPrevHash) {
      brokenLogId = log.id;
      break;
    }

    // 2. Recompute the hash of the current payload over ALL fields (V2).
    // Amounts are canonicalized via canonLedgerAmount: NUMERIC columns come
    // back from Postgres as strings ("5000.00") but were hashed as numbers.
    const payloadV2 = JSON.stringify({
      user_id: log.user_id,
      sequence_num: Number(log.sequence_num),
      action: log.action,
      invoice_id: log.invoice_id || null,
      invoice_number: log.invoice_number || null,
      amount: canonLedgerAmount(log.amount),
      agent_address: log.agent_address || null,
      owner_address: log.owner_address || null,
      tx_hash: log.tx_hash || null,
      details: log.details || null,
      prev_hash: log.prev_hash,
      timestamp: toUtcIso(log.created_ts)
    });
    
    // Legacy V1 payload
    const payloadV1 = JSON.stringify({
      action: log.action,
      details: log.details || null,
      prev_hash: log.prev_hash,
      timestamp: toUtcIso(log.created_ts)
    });
    
    const computedHashV2 = crypto.createHash('sha256').update(payloadV2).digest('hex');
    const computedHashV1 = crypto.createHash('sha256').update(payloadV1).digest('hex');

    // 3. Verify it matches the stored hash (allow V1 or V2)
    if (log.hash !== computedHashV2 && log.hash !== computedHashV1) {
      brokenLogId = log.id;
      break;
    }

    verified++;
    // Set the expected next prev_hash
    expectedPrevHash = log.hash;
  }

  if (brokenLogId) {
    return res.json({ valid: false, broken_log_id: brokenLogId, entries_verified: verified, message: 'CRITICAL: Hash chain broken or data tampered.' });
  }

  res.json({ valid: true, entries_verified: verified, message: 'Cryptographic ledger is 100% mathematically valid.' });
});

import { createAgentSettlementOrder, captureAutonomousPayment, verifyWebhookSignature, verifySignature, isRazorpayConfigured, computeTaxSplit, fetchPayment } from './razorpay.js';

// --- Agent-to-Agent Commerce (x402 Protocol) ---
// TWO DISTINCT IDENTITIES: the requesting user is the AI BUYER agent; the
// invoice is owned by the MERCHANT account (role='merchant', lazily seeded).
// No self-dealing: the seller and payer are different principals.

async function getOrCreateMerchant() {
  const res = await query("SELECT id, email, name FROM users WHERE role = 'merchant' LIMIT 1");
  if (res.rows[0]) return res.rows[0];
  const id = uuidv4();
  const email = process.env.MERCHANT_AGENT_EMAIL || 'merchant@agentic-copilot.local';
  await query(
    "INSERT INTO users (id, email, password, name, role, is_verified) VALUES ($1, $2, $3, $4, 'merchant', 1)",
    [id, email, bcrypt.hashSync(uuidv4(), 10), 'Merchant (AI Seller)']
  );
  return { id, email, name: 'Merchant (AI Seller)' };
}
// Compute the CGST/SGST/IGST split for an invoice using its stored GST/state fields.
function invoiceTaxSplit(invoice) {
  const s = invoice.subtotal || 0;
  const rate = s > 0 ? Math.round((invoice.tax_total || 0) / s * 100) : 18;
  return computeTaxSplit({
    subtotal: s,
    rate,
    sellerGstin: invoice.gst_number || invoice.institution_address,
    buyerGstin: invoice.recipient_gst || invoice.recipient_address,
  });
}

app.post('/api/agent/b2b-buy', authMiddleware, agentBuyRateLimiter, async (req, res) => {
  if (await getOpsFlag('settle_disabled')) {
    return res.status(503).json({ error: 'settlement_halted', message: 'Machine checkout is halted by the ops kill-switch.' });
  }
  const { product_id, quantity = 1 } = req.body;

  // Quantity is money-adjacent: negatives forge credit, 0/huge values create
  // dust or giant invoices before Razorpay ever sees them.
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
    return res.status(400).json({ error: 'invalid_quantity', message: 'quantity must be an integer between 1 and 1000.' });
  }

  // 1. Validate Product — against the REAL machine-readable catalog
  const product = AGENT_CATALOG?.catalog?.find(p => p.id === product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const subtotal = product.price * qty;
  const tax = (subtotal * (product.tax_rate || 18)) / 100;
  const grand_total = subtotal + tax;

  const merchant = await getOrCreateMerchant();

  // FAIL-LOUD: refuse before creating any state when Razorpay is unconfigured.
  // The order is created AFTER the invoice insert below, so without this guard
  // a missing key would leave a dangling 'pending' invoice and an unhandled
  // rejection instead of a clear 503.
  if (!isRazorpayConfigured()) {
    return res.status(503).json({
      error: 'razorpay_not_configured',
      message: 'Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. No 402 challenge or invoice was created.',
    });
  }

  // 2. Draft the invoice in the MERCHANT's books, recipient = the buyer agent
  const invoiceNumber = `INV-AI-${Math.floor(1000 + Math.random() * 9000)}`;
  const invoiceId = uuidv4();
  await query(`
    INSERT INTO invoices (id, user_id, buyer_id, invoice_number, recipient_name, line_items, subtotal, tax_total, grand_total, currency, status, tx_hash, invoice_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [
    invoiceId, merchant.id, req.user.id, invoiceNumber, `AI Buyer Agent (${req.user.email})`,
    JSON.stringify([{ sku: product.id, description: product.name, quantity: qty, price: product.price, total: subtotal }]),
    subtotal, tax, grand_total, 'INR', 'pending', null, new Date().toISOString()
  ]);

  // 3. Create Razorpay Order and anchor it on the invoice (challenge proof)
  const { order } = await createAgentSettlementOrder(grand_total, invoiceNumber, tax, computeTaxSplit({ subtotal, rate: product.tax_rate || 18, sellerGstin: null, buyerGstin: null }));
  await query('UPDATE invoices SET tx_hash = $1 WHERE id = $2', [order.id, invoiceId]);
await query("UPDATE invoices SET tax_breakdown = $1 WHERE id = $2", [JSON.stringify(computeTaxSplit({ subtotal, rate: product.tax_rate || 18, sellerGstin: null, buyerGstin: null })), invoiceId]);

  await appendAuditLog(req.user.id, {
    action: 'x402_handshake_initiated',
    invoice_id: invoiceId, invoice_number: invoiceNumber, amount: grand_total,
    details: `AI Buyer requested ${product.name} from merchant ${merchant.email}. Issued HTTP 402 challenge (${order.id}).`
  });

  // 4. Return HTTP 402 Payment Required!
  // This is the core of the machine-to-machine protocol.
  res.status(402)
     .setHeader('Www-Authenticate', `Razorpay order_id="${order.id}", invoice_id="${invoiceId}"`)
     .json({
       error: 'payment_required',
       message: 'Payment required to fulfill this machine request.',
       payment_protocol: 'x402_razorpay',
       order_id: order.id,
       invoice_id: invoiceId,
       amount_due: grand_total,
       currency: 'INR',
       next_step: 'POST /api/agent/b2b-pay with { invoice_id, order_id }'
     });
});

// Standard human checkout (bypasses agent budget gates — the human is the bound)
app.post('/api/checkout/order', authMiddleware, agentBuyRateLimiter, async (req, res) => {
  if (await getOpsFlag('settle_disabled')) {
    return res.status(503).json({ error: 'settlement_halted', message: 'Checkout is halted by the ops kill-switch.' });
  }
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'bad_request', message: 'invoice_id is required' });

  // Ownership: nobody mints orders on, or clobbers the anchor of, another principal's invoice.
  const invRes = await query('SELECT * FROM invoices WHERE id = $1 AND (user_id = $2 OR buyer_id = $2)', [invoice_id, req.user.id]);
  if (invRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invRes.rows[0];

  if (invoice.status === 'paid') return res.status(409).json({ error: 'already_paid', message: 'Invoice already paid' });
  // Never overwrite an in-flight 402 anchor — that would orphan a live Razorpay order.
  if (invoice.tx_hash && invoice.tx_hash.startsWith('order_') && invoice.status === 'processing') {
    return res.status(409).json({ error: 'already_processing', message: 'Invoice has an in-flight payment. Complete or wait for it to release.' });
  }

  try {
    const { order } = await createAgentSettlementOrder(invoice.grand_total, invoice.invoice_number, invoice.tax_total || 0, invoiceTaxSplit(invoice));
    await query('UPDATE invoices SET tx_hash = $1 WHERE id = $2', [order.id, invoice.id]);
    res.json({ order_id: order.id, amount: Math.round(invoice.grand_total * 100), currency: invoice.currency || 'INR' });
  } catch (err) {
    res.status(500).json({ error: 'order_failed', message: err.message });
  }
});

// The buyer agent completes the 402 challenge: pays the merchant's order S2S.
// --- REAL A2A PROTOCOL (x402) ---

app.get('/api/agent/v1/catalog', authMiddleware, async (req, res) => {
  const products = await query('SELECT sku, name, description, price, hsn_code FROM products');
  res.json({
    protocol: 'x402',
    merchant: 'AgentPay Gateway',
    currency: 'INR',
    items: products.rows
  });
});

app.post('/api/agent/v1/quote', authMiddleware, agentBuyRateLimiter, async (req, res) => {
  if (await getOpsFlag('settle_disabled')) {
    return res.status(503).json({ error: 'settlement_halted', message: 'Machine checkout is halted by the ops kill-switch.' });
  }
  const { line_items } = req.body;
  if (!Array.isArray(line_items) || line_items.length === 0 || line_items.length > 50) {
    return res.status(400).json({ error: 'bad_request', message: 'line_items must be a non-empty array (max 50 items)' });
  }

  const productsRes = await query('SELECT sku, name, margin_floor, price, hsn_code FROM products');
  const products = productsRes.rows;
  
  let subtotal = 0;
  let tax_total = 0;
  const processedItems = [];

  for (const item of line_items) {
    if (!item.sku || typeof item.sku !== 'string') return res.status(400).json({ error: 'invalid_item', message: 'sku (string) required' });
    const dbProduct = products.find(p => p.sku === item.sku);
    if (!dbProduct) return res.status(400).json({ error: 'invalid_sku', message: `SKU ${item.sku} not found` });

    // negotiated_price must be a real non-negative number — a string here
    // would slip past `<` ("abc" < floor is false) and mint a NaN/₹0 order.
    const rawPrice = item.negotiated_price ?? dbProduct.price;
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'invalid_price', message: 'negotiated_price must be a finite non-negative number.' });
    }
    if (price < Number(dbProduct.margin_floor)) {
      return res.status(400).json({ 
        error: 'margin_floor_violation', 
        message: `Price ${price} below margin floor ${dbProduct.margin_floor} for ${dbProduct.name}`
      });
    }

    const qty = Number(item.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return res.status(400).json({ error: 'invalid_quantity', message: 'quantity must be an integer between 1 and 1000.' });
    }
    const taxRate = 18; // Default GST
    const itemTotal = price * qty;
    const itemTax = Math.round(itemTotal * taxRate / 100);
    
    subtotal += itemTotal;
    tax_total += itemTax;
    
    processedItems.push({
      sku: dbProduct.sku,
      description: dbProduct.name,
      hsn_code: dbProduct.hsn_code,
      quantity: qty,
      unit_price: price,
      tax_rate: taxRate,
      total: itemTotal
    });
  }

  const grand_total = subtotal + tax_total;
  const merchant = await getOrCreateMerchant();
  const invoiceNumber = `A2A-${Math.floor(Math.random() * 1000000)}`;
  const invoiceId = uuidv4();

  // Create Razorpay Order
  const { order } = await createAgentSettlementOrder(
    grand_total, 
    invoiceNumber, 
    tax_total, 
    computeTaxSplit({ subtotal, rate: 18, sellerGstin: null, buyerGstin: null })
  );

  // Save as pending draft anchored to the order
  await query(`
    INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address,
      line_items, subtotal, tax_total, grand_total, currency, status, tx_hash,
      invoice_date, due_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
  `, [
    invoiceId, req.user.id, invoiceNumber, merchant.name, 'New Delhi, India',
    JSON.stringify(processedItems), subtotal, tax_total, grand_total, 'INR', 'pending', order.id
  ]);

  await appendAuditLog(req.user.id, {
    action: 'x402_handshake_initiated',
    invoice_id: invoiceId, invoice_number: invoiceNumber, amount: grand_total,
    details: `A2A quote generated for AI Buyer. Issued HTTP 402 challenge (${order.id}).`
  });

  // The true machine-readable x402 challenge
  res.status(402)
     .setHeader('Www-Authenticate', `Razorpay order_id="${order.id}", invoice_id="${invoiceId}"`)
     .json({
       error: 'payment_required',
       message: 'Payment required to fulfill this machine request.',
       payment_protocol: 'x402_razorpay',
       order_id: order.id,
       invoice_id: invoiceId,
       amount_due: grand_total,
       currency: 'INR',
       next_step: 'POST /api/agent/v1/settle with { invoice_id, order_id }'
     });
});

async function handleSettleB2BPay(req, res) {
  if (await getOpsFlag('settle_disabled')) {
    await appendAuditLog(req.user.id, { action: 'settlement_blocked', details: 'Blocked: ops kill-switch settle_disabled is engaged.' }).catch(() => {});
    return res.status(503).json({ error: 'settlement_halted', message: 'Autonomous settlement is halted by the ops kill-switch. Escalate to a human.' });
  }
  const { invoice_id, order_id } = req.body;
  if (!invoice_id || !order_id) {
    return res.status(400).json({ error: 'bad_request', message: 'invoice_id and order_id (from the 402 challenge) are required.' });
  }

  // Fetch buyer's mandate details + delegation caps (the payer is the buyer agent)
  const userRes = await query('SELECT razorpay_customer_id, razorpay_token_id, agent_delegation_max FROM users WHERE id = $1', [req.user.id]);
  const { razorpay_customer_id, razorpay_token_id, agent_delegation_max } = userRes.rows[0] || {};
  const delegation_max = Number(agent_delegation_max || 0);

  // The challenge must match: invoice exists AND was anchored to THIS order,
  // AND the caller is a principal on it (buyer settling own challenge, or the
  // merchant owning it). Order IDs leak in 402 headers — possession of the pair
  // alone must not let a stranger spend their mandate on your invoice.
  const invRes = await query(
    'SELECT * FROM invoices WHERE id = $1 AND tx_hash = $2 AND (buyer_id = $3 OR user_id = $3)',
    [invoice_id, order_id, req.user.id]
  );
  if (invRes.rows.length === 0) {
    return res.status(404).json({ error: 'challenge_not_found', message: 'No matching 402 challenge for this invoice/order pair.' });
  }
  const invoice = invRes.rows[0];

  // Idempotency: an already-paid challenge cannot be replayed
  if (invoice.status === 'paid') {
    return res.status(409).json({ error: 'already_settled', message: 'This challenge has already been paid.', payment_id: invoice.tx_hash });
  }

  // BUDGET GATE: the buyer's own delegation bounds machine settlement too —
  // without this, a bound mandate token could settle any challenge amount.
  const budgetBlock = await enforceBudget(req.user.id, Number(invoice.grand_total), delegation_max);
  if (budgetBlock) {
    await appendAuditLog(req.user.id, {
      ...budgetBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(budgetBlock.status).json(budgetBlock.body);
  }

  // Deterministic mandate (SKU allowlist) gate
  const mandateBlock = await enforceMandate(invoice);
  if (mandateBlock) {
    await refundBudget(req.user.id, Number(invoice.grand_total));
    await appendAuditLog(req.user.id, {
      ...mandateBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(mandateBlock.status).json(mandateBlock.body);
  }

  // ATOMIC CLAIM so two buyer agents cannot double-pay one challenge
  const claim = await query(
    `UPDATE invoices SET status = 'processing', updated_date = NOW()
     WHERE id = $1 AND status NOT IN ('paid', 'processing') RETURNING id`,
    [invoice.id]
  );
  if (claim.rows.length === 0) {
    await refundBudget(req.user.id, Number(invoice.grand_total));
    return res.status(409).json({ error: 'already_processing', message: 'Challenge is being settled by another request.' });
  }

  try {
    const settlement = await captureAutonomousPayment(order_id, invoice.grand_total, razorpay_token_id, razorpay_customer_id);

    if (settlement.mode === 'mandate_captured') {
      // Money moved - Razorpay-verified capture
      await query(
        "UPDATE invoices SET status = 'paid', tx_hash = $1, payment_method = 'razorpay_x402', updated_date = NOW() WHERE id = $2",
        [settlement.payment.id, invoice.id]
      );
      await bumpCampaignForInvoice(invoice.id, 'paid');

      // Audit BOTH sides of the transaction
      await appendAuditLog(invoice.user_id, {
        action: 'x402_sale_settled',
        invoice_id: invoice.id, invoice_number: invoice.invoice_number,
        amount: invoice.grand_total, tx_hash: settlement.payment.id,
        details: `Merchant received autonomous payment ${settlement.payment.id} from AI buyer agent (${req.user.email}).`
      });
      await appendAuditLog(req.user.id, {
        action: 'x402_purchase_paid',
        invoice_id: invoice.id, invoice_number: invoice.invoice_number,
        amount: invoice.grand_total, tx_hash: settlement.payment.id,
        details: `Buyer agent completed the 402 challenge: paid ${settlement.payment.id} to merchant (mandate source: ${settlement.via}).`
      });

      return res.json({
        success: true,
        payment_protocol: 'x402_razorpay',
        order_id,
        payment_id: settlement.payment.id,
        status: 'captured',
        mandate_via: settlement.via
      });
    }

    // Buyer agent has no mandate token - the challenge stays open, a real
    // Payment Link is issued for a human to complete. Honest escalation.
    await query("UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1", [invoice.id]);
    await appendAuditLog(req.user.id, {
      action: 'x402_escalated',
      invoice_id: invoice.id, invoice_number: invoice.invoice_number, amount: invoice.grand_total,
      details: `Buyer agent lacks a mandate token. Escalated to human payment link ${settlement.paymentLink.id}.`
    });
    return res.status(402).json({
      error: 'payment_required',
      message: 'Buyer agent has no saved mandate token. A human payment link was issued.',
      payment_link_url: settlement.paymentLink.short_url,
      order_id,
      invoice_id
    });
  } catch (err) {
    // Release the claim so the challenge stays retryable, and refund the
    // budget reservation (mirrors /api/agent/auto-settle error semantics)
    await query("UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1 AND status = 'processing'", [invoice.id]);
    await refundBudget(req.user.id, Number(invoice.grand_total));
    console.error('x402 payment error:', err);
    return res.status(500).json({ error: 'payment_error', message: err.message });
  }
}

app.post('/api/agent/v1/settle', authMiddleware, agentSettleRateLimiter, handleSettleB2BPay);
app.post('/api/agent/b2b-pay', authMiddleware, agentSettleRateLimiter, handleSettleB2BPay);



// --- Razorpay Agentic Commerce ---
app.post('/api/agent/settle', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  if (await getOpsFlag('settle_disabled')) {
    return res.status(503).json({ error: 'settlement_halted', message: 'Autonomous settlement is halted by the ops kill-switch.' });
  }
  const { invoice_id } = req.body;
  const userRes = await query('SELECT agent_delegation_max FROM users WHERE id = $1', [req.user.id]);
  const delegation_max = Number(userRes.rows[0]?.agent_delegation_max || 0);

  // Allow lookup by either UUID or human-readable invoice_number, for either merchant or buyer
  const invoiceRes = await query(
    `SELECT * FROM invoices 
     WHERE (id = $1 OR invoice_number = $1) 
       AND (user_id = $2 OR buyer_id = $2 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $2)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $2))`,
    [invoice_id, req.user.id]
  );
  if (invoiceRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invoiceRes.rows[0];

  // IDEMPOTENCY GUARD: Prevent double-spend / duplicate settlements
  if (invoice.status === 'paid') {
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already paid. Duplicate settlement blocked.`
    });
  }

  // BUDGET GATE: per-tx + per-day (must come BEFORE compliance gate so a
  // budget breach is the more informative reason).
  const budgetBlock = await enforceBudget(req.user.id, invoice.grand_total, delegation_max);
  if (budgetBlock) {
    await appendAuditLog(req.user.id, {
      ...budgetBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(budgetBlock.status).json(budgetBlock.body);
  }

  // GATE 1 & 2: Deterministic Mandate Check (replaces compliance_score).
  const mandateBlock = await enforceMandate(invoice);
  if (mandateBlock) {
    // Refund the reserved budget since we're blocking it
    await refundBudget(req.user.id, invoice.grand_total);
    await appendAuditLog(req.user.id, {
      ...mandateBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(mandateBlock.status).json(mandateBlock.body);
  }

  // ATOMIC CLAIM (TOCTOU guard): single-statement check+claim. Postgres row lock
  // guarantees only ONE concurrent request can claim this invoice.
  const claim = await query(
    `UPDATE invoices SET status = 'processing', updated_date = NOW()
     WHERE (id = $1 OR invoice_number = $1) 
       AND (user_id = $2 OR buyer_id = $2 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $2)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $2))
       AND status NOT IN ('paid', 'processing')
     RETURNING id`,
    [invoice_id, req.user.id]
  );
  if (claim.rows.length === 0) {
    // Budget was already reserved above — refund it so a lost claim race
    // doesn't burn the loser's daily autonomous spend.
    await refundBudget(req.user.id, Number(invoice.grand_total));
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already settled or being processed by another request.`
    });
  }

  try {
    // Feature 2: Razorpay Route split payment (taxes)
    const taxAmount = invoice.tax_total || 0;
    const { order } = await createAgentSettlementOrder(invoice.grand_total, invoice.invoice_number, taxAmount, invoiceTaxSplit(invoice));
    
    await query('UPDATE invoices SET status = $1, tx_hash = $2 WHERE id = $3 AND user_id = $4', ['pending', order.id, invoice.id, req.user.id]);

    await appendAuditLog(req.user.id, {
      action: 'order_created',
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      amount: invoice.grand_total,
      details: `Razorpay Order ${order.id} generated autonomously.`
    });

    res.json({ success: true, order, invoice_uuid: invoice.id });
  } catch (err) {
    // Release the claim AND refund the reservation (mirrors auto-settle) so a
    // Razorpay failure neither wedges the invoice at `processing` nor burns budget.
    await query(
      "UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1 AND user_id = $2 AND status = 'processing'",
      [invoice.id, req.user.id]
    );
    await refundBudget(req.user.id, Number(invoice.grand_total));
    console.error(err);
    res.status(500).json({ error: 'payment_error', message: 'Failed to create Razorpay Order' });
  }
});

app.post('/api/agent/auto-settle', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  if (await getOpsFlag('settle_disabled')) {
    return res.status(503).json({ error: 'settlement_halted', message: 'Autonomous settlement is halted by the ops kill-switch.' });
  }
  const { invoice_id } = req.body;
  const userRes = await query('SELECT agent_delegation_max, razorpay_customer_id, razorpay_token_id FROM users WHERE id = $1', [req.user.id]);
  const delegation_max = Number(userRes.rows[0]?.agent_delegation_max || 0);
  const { razorpay_customer_id, razorpay_token_id } = userRes.rows[0] || {};

  // Allow lookup by either UUID or human-readable invoice_number, for either merchant or buyer
  const invoiceRes = await query(
    `SELECT * FROM invoices 
     WHERE (id = $1 OR invoice_number = $1) 
       AND (user_id = $2 OR buyer_id = $2 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $2)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $2))`,
    [invoice_id, req.user.id]
  );
  if (invoiceRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invoiceRes.rows[0];

  // IDEMPOTENCY GUARD: Prevent autonomous double-settlement
  if (invoice.status === 'paid') {
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already paid. Autonomous re-settlement blocked for idempotency.`,
      order_id: invoice.tx_hash
    });
  }

  // BUDGET GATE (per-tx + per-day). Reserves daily budget atomically.
  const budgetBlock = await enforceBudget(req.user.id, invoice.grand_total, delegation_max);
  if (budgetBlock) {
    await appendAuditLog(req.user.id, {
      ...budgetBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(budgetBlock.status).json(budgetBlock.body);
  }

  // GATE 1 & 2: Deterministic Mandate Check (replaces compliance_score).
  const mandateBlock = await enforceMandate(invoice);
  if (mandateBlock) {
    await refundBudget(req.user.id, invoice.grand_total);
    await appendAuditLog(req.user.id, {
      ...mandateBlock.audit,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
    });
    return res.status(mandateBlock.status).json(mandateBlock.body);
  }

  // ATOMIC CLAIM (TOCTOU guard): single-statement check+claim before any money
  // moves. Row-level lock ensures only ONE concurrent request wins the claim.
  const claim = await query(
    `UPDATE invoices SET status = 'processing', updated_date = NOW()
     WHERE (id = $1 OR invoice_number = $1) 
       AND (user_id = $2 OR buyer_id = $2 
            OR recipient_name ILIKE (SELECT name FROM users WHERE id = $2)
            OR recipient_name ILIKE (SELECT email FROM users WHERE id = $2))
       AND status NOT IN ('paid', 'processing')
     RETURNING id`,
    [invoice_id, req.user.id]
  );
  if (claim.rows.length === 0) {
    await refundBudget(req.user.id, Number(invoice.grand_total));
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already settled or being processed by another request.`,
      order_id: invoice.tx_hash
    });
  }

  try {
    // Feature 8: True Autonomous S2S Capture via Razorpay API
    // 1. Actually hit the Razorpay Orders API to prove real integration
    const taxAmount = invoice.tax_total || 0;
    const { order } = await createAgentSettlementOrder(invoice.grand_total, invoice.invoice_number, taxAmount, invoiceTaxSplit(invoice));

    // 2. True S2S settlement: charge the saved mandate token, or escalate to a
    //    real Payment Link when the agent has no token (graceful human fallback)
    const settlement = await captureAutonomousPayment(order.id, invoice.grand_total, razorpay_token_id, razorpay_customer_id);

    let txHash, response;
    if (settlement.mode === 'mandate_captured') {
      // Agent successfully charged autonomously — verify Razorpay says 'captured'
      txHash = settlement.payment.id;
      await query('UPDATE invoices SET status = $1, tx_hash = $2 WHERE id = $3', ['paid', txHash, invoice.id]);

      await appendAuditLog(req.user.id, {
        action: 'settlement_auto',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        amount: invoice.grand_total,
        tx_hash: txHash,
        details: `Autonomous S2S capture successful. Razorpay Order ${order.id}, Payment ${txHash} verified as 'captured' (mandate source: ${settlement.via}).`
      });

      response = { success: true, message: 'Autonomously captured via S2S API', order_id: order.id, payment_id: txHash, invoice_uuid: invoice.id, mandate_via: settlement.via };
    } else {
      // No mandate token — agent escalates to a REAL Razorpay Payment Link
      txHash = order.id;
      await query('UPDATE invoices SET status = $1, tx_hash = $2 WHERE id = $3', ['pending', txHash, invoice.id]);

      await appendAuditLog(req.user.id, {
        action: 'settlement_escalated',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        amount: invoice.grand_total,
        tx_hash: txHash,
        details: `Agent lacks mandate token. Escalated to human via Razorpay Payment Link ${settlement.paymentLink.id}.`
      });

      response = {
        success: true,
        message: 'Agent cannot charge without a mandate token. Human checkout required.',
        escalation: true,
        order_id: order.id,
        payment_link_id: settlement.paymentLink.id,
        payment_link_url: settlement.paymentLink.short_url,
        invoice_uuid: invoice.id,
      };
    }

    res.json(response);
  } catch (err) {
    // RELEASE the claim so the invoice stays retryable after a transient error
    await query(
      "UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1 AND status = 'processing'",
      [invoice.id]
    );
    await refundBudget(req.user.id, invoice.grand_total);
    console.error('Razorpay auto-settle error:', err);
    res.status(500).json({ error: 'razorpay_error', message: err.message });
  }
});

// Securely update user's delegation limit. Does NOT touch Razorpay mandate
// tokens — that is an explicit, separate, audited operation.
app.post('/api/user/delegation', authMiddleware, async (req, res) => {
  const { maxAmount, dailyLimit } = req.body;
  // Caps are money gates: negatives permanently self-DoS (amount > -1 always
  // blocks), NaN disables nothing predictable, huge values overflow NUMERIC.
  const maxN = Number(maxAmount), dailyN = dailyLimit != null ? Number(dailyLimit) : null;
  if (!Number.isFinite(maxN) || maxN < 0 || maxN > 99999999.99) {
    return res.status(400).json({ error: 'invalid_cap', message: 'maxAmount must be between 0 and 99,999,999.99.' });
  }
  if (dailyN !== null && (!Number.isFinite(dailyN) || dailyN < 0 || dailyN > 99999999.99)) {
    return res.status(400).json({ error: 'invalid_cap', message: 'dailyLimit must be between 0 and 99,999,999.99.' });
  }
  try {
    await query(
      "UPDATE users SET agent_delegation_max = $1, agent_daily_limit = COALESCE($2, agent_daily_limit) WHERE id = $3",
      [maxN, dailyN, req.user.id]
    );
    await appendAuditLog(req.user.id, {
      action: 'delegation_updated',
      amount: maxN,
      details: `Delegation cap updated to ₹${maxN}${dailyN != null ? `, daily limit ₹${dailyN}` : ''}.`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// Explicit, audited Razorpay mandate binding. No silent shortcuts — if a
// token is not provided, the previous binding (if any) is cleared.
app.post('/api/user/razorpay-mandate', authMiddleware, async (req, res) => {
  const { razorpay_customer_id, razorpay_token_id } = req.body || {};
  if (!razorpay_customer_id || !razorpay_token_id) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Both razorpay_customer_id and razorpay_token_id are required to bind a mandate.'
    });
  }
  try {
    await query(
      'UPDATE users SET razorpay_customer_id = $1, razorpay_token_id = $2 WHERE id = $3',
      [razorpay_customer_id, razorpay_token_id, req.user.id]
    );
    await appendAuditLog(req.user.id, {
      action: 'mandate_bound',
      details: `Razorpay mandate token ${razorpay_token_id} bound for customer ${razorpay_customer_id}.`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// Clear mandate (e.g. on card rotation). Audited.
app.delete('/api/user/razorpay-mandate', authMiddleware, async (req, res) => {
  try {
    await query(
      'UPDATE users SET razorpay_customer_id = NULL, razorpay_token_id = NULL WHERE id = $1',
      [req.user.id]
    );
    await appendAuditLog(req.user.id, {
      action: 'mandate_revoked',
      details: 'Razorpay mandate token cleared.'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message });
  }
});

// --- AP2-style signed Intent Mandate (authorization layer) ---
// Returns the caller's CFO mandate as a tamper-evident document: HMAC-signed
// with RAZORPAY_KEY_SECRET (fail-closed when unconfigured). An agent carrying
// this mandate proves a human authorized the spend envelope; enforcement still
// happens server-side in enforceBudget/enforceMandate — the signature is the
// audit artifact, not the gate.
app.get('/api/user/mandate', authMiddleware, async (req, res) => {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(503).json({ error: 'mandate_signing_unconfigured', message: 'RAZORPAY_KEY_SECRET is not set — cannot sign mandates.' });
  const uRes = await query(
    'SELECT agent_delegation_max, agent_daily_limit, agent_daily_spent, razorpay_customer_id FROM users WHERE id = $1',
    [req.user.id]
  );
  const u = uRes.rows[0] || {};
  const mandate = {
    protocol: 'ap2_intent_mandate/0.1',
    subject: req.user.id,
    per_transaction_max: Number(u.agent_delegation_max || 0),
    daily_limit: Number(u.agent_daily_limit || 0),
    daily_spent: Number(u.agent_daily_spent || 0),
    mandate_bound: Boolean(u.razorpay_customer_id),
    issued_at: new Date().toISOString(),
  };
  const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(mandate)).digest('hex');
  res.json({ mandate, signature, algorithm: 'HMAC-SHA256' });
});

// --- Ops kill-switches (Failure Theater) ---
// Judges can halt autonomous money movement without deploying. Every change is audited.
async function getOpsFlag(flag) {
  try {
    const r = await query('SELECT enabled FROM ops_flags WHERE flag = $1', [flag]);
    return r.rows[0]?.enabled === true;
  } catch { return false; }
}
app.get('/api/ops/flags', authMiddleware, async (req, res) => {
  res.json({
    settle_disabled: await getOpsFlag('settle_disabled'),
    llm_disabled: await getOpsFlag('llm_disabled'),
  });
});
app.post('/api/ops/flags', authMiddleware, async (req, res) => {
  const { flag, enabled } = req.body || {};
  if (!['settle_disabled', 'llm_disabled'].includes(flag)) {
    return res.status(400).json({ error: 'bad_request', message: 'flag must be settle_disabled or llm_disabled' });
  }
  // RBAC: halting settlement (or simulating an outage) is merchant-only — a
  // foreign buyer must never be able to freeze the merchant's money movement.
  // Releasing an LLM halt (enabled=false) stays open so a jailed buyer can
  // recover from inside the chat via the Restore button.
  const role = req.user?.role;
  const isRelease = flag === 'llm_disabled' && !enabled;
  if (!isRelease && role !== 'merchant' && role !== 'admin') {
    await appendAuditLog(req.user.id, {
      action: 'settlement_blocked',
      details: `Blocked ops flag change by non-merchant role '${role || 'unknown'}': ${flag}=${Boolean(enabled)}.`,
    }).catch(() => {});
    return res.status(403).json({ error: 'forbidden', message: 'Ops kill-switches are merchant-only.' });
  }
  await query(
    `INSERT INTO ops_flags (flag, enabled, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (flag) DO UPDATE SET enabled = $2, updated_at = NOW()`,
    [flag, Boolean(enabled)]
  );
  await appendAuditLog(req.user.id, {
    action: enabled ? 'ops_kill_switch_engaged' : 'ops_kill_switch_released',
    details: `Ops flag ${flag} set to ${Boolean(enabled)}.`,
  });
  res.json({ flag, enabled: Boolean(enabled) });
});

// --- Budget-packing bundler (deterministic revenue lever) ---
// Given a disclosed budget cap and an optional anchor SKU, returns the
// highest-margin complement bundle that fits entirely within headroom.
// Pure function over the products table — the LLM may suggest, but this
// endpoint is the auditable math judges can re-run.
app.post('/api/agent/pack-bundle', authMiddleware, async (req, res) => {
  const { budget_cap, base_sku = null, exclude_skus = [] } = req.body || {};
  if (!Number.isFinite(Number(budget_cap)) || Number(budget_cap) <= 0) {
    return res.status(400).json({ error: 'bad_request', message: 'budget_cap (positive number) is required' });
  }
  const cap = Number(budget_cap);
  const productsRes = await query('SELECT sku, name, description, price, margin_floor FROM products');
  const catalog = productsRes.rows.filter(p => p.sku && !exclude_skus.includes(p.sku));
  if (catalog.length === 0) return res.status(404).json({ error: 'empty_catalog', message: 'No products available to pack.' });
  const anchor = base_sku ? catalog.find(p => p.sku === base_sku) : null;
  if (base_sku && !anchor) return res.status(404).json({ error: 'invalid_sku', message: `Base SKU ${base_sku} not found.` });
  const anchorTotal = anchor ? Number(anchor.price) * 1.18 : 0;
  const headroom = cap - anchorTotal;
  if (headroom < 0) {
    return res.status(402).json({ error: 'budget_exceeded', message: `Anchor alone (₹${anchorTotal.toFixed(2)} incl. tax) exceeds budget cap ₹${cap}.`, headroom });
  }
  // Candidates: complements fitting headroom, ranked by absolute margin (price - floor).
  const candidates = catalog
    .filter(p => !anchor || p.sku !== anchor.sku)
    .map(p => ({ ...p, priceN: Number(p.price), margin: Number(p.price) - Number(p.margin_floor), total: Number(p.price) * 1.18 }))
    .filter(p => p.total <= headroom && p.margin > 0)
    .sort((a, b) => b.margin - a.margin);
  const pick = candidates[0] || null;
  res.json({
    budget_cap: cap,
    anchor: anchor ? { sku: anchor.sku, name: anchor.name, total_incl_tax: Number(anchorTotal.toFixed(2)) } : null,
    headroom: Number(headroom.toFixed(2)),
    recommendation: pick ? {
      sku: pick.sku, name: pick.name, price: pick.priceN,
      total_incl_tax: Number(pick.total.toFixed(2)),
      expected_margin: Number(pick.margin.toFixed(2)),
      reason: `Highest-margin complement fitting ₹${headroom.toFixed(2)} headroom.`,
    } : null,
    message: pick ? `Pack ${pick.name} (₹${pick.total.toFixed(2)}) into ₹${headroom.toFixed(2)} headroom.` : 'No complement fits the remaining headroom — hold the anchor.',
  });
});

// --- Growth funnel (measured revenue proof for the pitch) ---
app.get('/api/growth/funnel', authMiddleware, async (req, res) => {
  const [suggested, accepted, paid, revenue] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM audit_logs WHERE user_id = $1 AND action IN ('campaign_converted','upsell_suggested','campaign_launched')`, [req.user.id]),
    query(`SELECT COALESCE(SUM(accepted),0)::int AS c FROM campaigns WHERE user_id = $1`, [req.user.id]),
    query(`SELECT COALESCE(SUM(paid),0)::int AS c FROM campaigns WHERE user_id = $1`, [req.user.id]),
    query(`SELECT COALESCE(SUM(grand_total),0)::float AS s FROM invoices WHERE user_id = $1 AND status = 'paid' AND is_ai_upsell = TRUE`, [req.user.id]),
  ]);
  const s = suggested.rows[0]?.c || 0;
  const a = accepted.rows[0]?.c || 0;
  const p = paid.rows[0]?.c || 0;
  res.json({
    suggested: s, accepted: a, paid: p,
    ai_upsell_revenue_inr: revenue.rows[0]?.s || 0,
    accept_rate: s ? Number((a / s).toFixed(3)) : null,
    convert_rate: a ? Number((p / a).toFixed(3)) : null,
  });
});

app.post('/api/agent/verify', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, invoice_id } = req.body;

  const isValid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!isValid) {
    return res.status(400).json({ error: 'invalid_signature', message: 'Payment verification failed' });
  }

  const invoiceRes = await query(
    'SELECT * FROM invoices WHERE id = $1 AND (user_id = $2 OR buyer_id = $2)',
    [invoice_id, req.user.id]
  );
  if (invoiceRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invoiceRes.rows[0];

  // Source-of-truth check: fetch the payment from Razorpay and require it to
  // be captured, bound to this order, and for the full invoice amount. A valid
  // HMAC alone proves nothing about amount — without this, a cheap payment's
  // signature replays against any expensive invoice.
  let payment;
  try {
    payment = await fetchPayment(razorpay_payment_id);
  } catch (err) {
    return res.status(400).json({ error: 'payment_not_found', message: 'Razorpay has no record of this payment.' });
  }
  if (payment.status !== 'captured') {
    return res.status(400).json({ error: 'payment_not_captured', message: `Payment status is '${payment.status}', not captured.` });
  }
  if (payment.order_id !== razorpay_order_id) {
    return res.status(400).json({ error: 'order_mismatch', message: 'Payment is not bound to this Razorpay order.' });
  }
  if (Math.abs(payment.amount - Math.round(Number(invoice.grand_total) * 100)) > 0) {
    return res.status(400).json({
      error: 'amount_mismatch',
      message: `Payment of ₹${(payment.amount / 100).toFixed(2)} does not cover invoice total ₹${Number(invoice.grand_total).toFixed(2)}.`,
    });
  }

  // Verify that the order matches the invoice anchor if an order was anchored
  if (invoice.tx_hash && invoice.tx_hash.startsWith('order_') && invoice.tx_hash !== razorpay_order_id) {
    return res.status(400).json({ error: 'order_mismatch', message: 'Razorpay order ID does not match this invoice' });
  }

  // Prevent double-spend / replaying an existing payment ID on multiple invoices
  const duplicatePayment = await query(
    'SELECT id, invoice_number FROM invoices WHERE tx_hash = $1 AND id != $2',
    [razorpay_payment_id, invoice_id]
  );
  if (duplicatePayment.rows.length > 0) {
    return res.status(409).json({ error: 'duplicate_payment', message: 'This payment transaction has already been credited to another invoice' });
  }

  // ATOMIC CLAIM (TOCTOU guard): only mark paid if not already paid/processing.
  const claim = await query(
    `UPDATE invoices SET status = 'paid', tx_hash = $1, payment_method = 'razorpay_agent', updated_date = NOW()
     WHERE id = $2 AND (user_id = $3 OR buyer_id = $3) AND status NOT IN ('paid', 'processing') RETURNING id`,
    [razorpay_payment_id, invoice_id, req.user.id]
  );
  if (claim.rows.length === 0) {
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already settled. Duplicate verification blocked.`
    });
  }

  // Log successful agent payment
  await appendAuditLog(req.user.id, {
    action: 'settlement_captured',
    invoice_id: invoice_id,
    invoice_number: invoice.invoice_number,
    amount: invoice.grand_total,
    tx_hash: razorpay_payment_id,
    details: 'Agent successfully verified and settled payment via Razorpay Checkout.'
  });

  // Closed-loop: campaign invoices verified here count as conversions too
  // (previously only webhook-paid invoices bumped the funnel).
  await bumpCampaignForInvoice(invoice_id, 'paid');

  res.json({ success: true, message: 'Payment verified successfully' });
});

// --- Campaigns ---
app.get('/api/campaigns', authMiddleware, async (req, res) => {
  const result = await query('SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_date DESC', [req.user.id]);
  res.json(result.rows);
});

app.post('/api/campaigns', authMiddleware, async (req, res) => {
  const { name, upsell_product_id, target_status, budget_cap } = req.body;
  if (!name || typeof name !== 'string' || name.length > 200) {
    return res.status(400).json({ error: 'invalid_name', message: 'Campaign name (max 200 chars) is required.' });
  }
  // Validate upsell targets against the catalog NOW — otherwise launch silently
  // yields 0 drafts (id-vs-sku key confusion) yet still marks `launched`.
  const ids = String(upsell_product_id || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'invalid_product', message: 'upsell_product_id (comma-separated product id or sku) is required.' });
  }
  const prodRes = await query('SELECT id, sku FROM products');
  const unknown = ids.filter(id => !prodRes.rows.some(p => p.id === id || p.sku === id));
  if (unknown.length > 0) {
    return res.status(400).json({ error: 'invalid_product', message: `Unknown product(s): ${unknown.join(', ')}` });
  }
  const id = uuidv4();
  await query(
    'INSERT INTO campaigns (id, user_id, name, target_status, upsell_product_id, budget_cap) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, req.user.id, name, target_status || 'validated', ids.join(','), Number(budget_cap) || 0]
  );
  res.json({ id });
});

app.put('/api/campaigns/:id', authMiddleware, async (req, res) => {
  const { name, upsell_product_id, target_status, budget_cap } = req.body;
  await query(
    'UPDATE campaigns SET name = $1, target_status = $2, upsell_product_id = $3, budget_cap = $4 WHERE id = $5 AND user_id = $6',
    [name, target_status, upsell_product_id, budget_cap || 0, req.params.id, req.user.id]
  );
  res.json({ success: true });
});

app.delete('/api/campaigns/:id', authMiddleware, async (req, res) => {
  await query('DELETE FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

app.post('/api/campaigns/:id/launch', authMiddleware, async (req, res) => {
  const campRes = await query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (campRes.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const campaign = campRes.rows[0];

  if (campaign.status === 'launched') {
    return res.status(400).json({ error: 'already_launched', message: 'Campaign is already launched. Revoke it before re-launching.' });
  }

  const statuses = campaign.target_status.split(',').map(s => s.trim()).filter(Boolean);
  // Target only organic customer invoices — never re-target existing campaign upsell drafts
  const targetRes = await query(
    'SELECT * FROM invoices WHERE user_id = $1 AND status = ANY($2) AND (is_ai_upsell IS NOT TRUE) AND (campaign_id IS NULL) LIMIT 20',
    [req.user.id, statuses]
  );
  const targets = targetRes.rows;

  const productsRes = await query('SELECT * FROM products');
  const catalog = productsRes.rows;

  let created = 0;
  for (const inv of targets) {
    const productIds = campaign.upsell_product_id.split(',').map(s => s.trim()).filter(Boolean);
    // Match on EITHER key (id or sku) — creation validates both, but legacy
    // campaigns may store either form.
    const itemsToUpsell = productIds.map(id => catalog.find(p => p.id === id || p.sku === id)).filter(Boolean);
    if (itemsToUpsell.length === 0) continue;
    
    // Create new invoice for the upsell
    const newId = uuidv4();
    const newInvNo = 'INV-' + Math.floor(Math.random() * 100000);
    
    let subtotal = 0;
    let tax_total = 0;
    const items = itemsToUpsell.map(item => {
      const amount = Number(item.price);
      const taxRate = Number(item.tax_rate) || 18;
      const tax = Math.round(amount * (taxRate / 100));
      subtotal += amount;
      tax_total += tax;
      return { sku: item.sku || item.id, description: item.name, quantity: 1, unit_price: amount, tax_rate: taxRate, total: amount, hsn_code: item.hsn_code || null };
    });
    const grand_total = subtotal + tax_total;
    
    await query(`
      INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address, gst_number,
        recipient_name, recipient_address, recipient_gst, line_items, subtotal, tax_total, grand_total,
        currency, status, is_ai_upsell, campaign_id, invoice_date, due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    `, [
      newId, req.user.id, newInvNo,
      inv.institution_name, inv.institution_address, inv.gst_number,
      inv.recipient_name, inv.recipient_address, inv.recipient_gst,
      JSON.stringify(items), subtotal, tax_total, grand_total,
      'INR', 'draft', true, campaign.id,
      new Date().toISOString().split('T')[0],
      new Date(Date.now() + 30*86400000).toISOString().split('T')[0]
    ]);
    
    const itemNames = itemsToUpsell.map(i => i.name).join(' & ');
    await appendAuditLog(req.user.id, {
      action: 'campaign_converted', // mapped to upsell_suggested
      details: `Campaign '${campaign.name}' generated upsell invoice ${newInvNo} for ${itemNames}`
    });
    created++;
  }

  // Flight semantics: each launch starts fresh counters (accepted/paid from a
  // previous flight would otherwise make rates exceed 1 after revoke relaunches).
  await query("UPDATE campaigns SET status = 'launched', sent = $1, accepted = 0, paid = 0 WHERE id = $2", [created, campaign.id]);
  await appendAuditLog(req.user.id, {
    action: 'campaign_launched',
    details: `Launched campaign '${campaign.name}' to ${created} targets.`
  });

  res.json({ targeted: targets.length, drafts_created: created });
});

app.post('/api/campaigns/:id/revoke', authMiddleware, async (req, res) => {
  const campRes = await query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (campRes.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  
  // Delete generated drafts that haven't been accepted yet
  await query("DELETE FROM invoices WHERE campaign_id = $1 AND user_id = $2 AND status = 'draft'", [req.params.id, req.user.id]);
  
  // Reset campaign to draft so it can be edited/relaunched
  await query("UPDATE campaigns SET status = 'draft', sent = 0 WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  
  await appendAuditLog(req.user.id, {
    action: 'campaign_revoked',
    details: `Revoked campaign '${campRes.rows[0].name}' and deleted its draft invoices.`
  });

  res.json({ success: true });
});

app.post('/api/campaigns/:id/dry-run', authMiddleware, async (req, res) => {
  const campRes = await query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (campRes.rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const campaign = campRes.rows[0];

  const statuses = campaign.target_status.split(',').map(s => s.trim()).filter(Boolean);
  const targetRes = await query(
    'SELECT * FROM invoices WHERE user_id = $1 AND status = ANY($2) AND (is_ai_upsell IS NOT TRUE) AND (campaign_id IS NULL) LIMIT 3',
    [req.user.id, statuses]
  );
  res.json({ previews: targetRes.rows });
});

app.post('/api/webhooks/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return res.status(400).send('No signature');

  // Verify HMAC over the EXACT raw bytes Razorpay signed (not re-serialized JSON)
  const isValid = verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), signature);
  if (!isValid) return res.status(400).send('Invalid signature');

  const event = req.body.event;
  const payment = req.body.payload?.payment?.entity;
  const order = req.body.payload?.order?.entity;
  const receipt = payment?.notes?.receipt || order?.receipt;
  const orderId = payment?.order_id || order?.id;
  
  // Razorpay may or may not send x-razorpay-event-id.
  // Idempotency is keyed on the PAYMENT when one is present: Razorpay emits
  // both payment.captured and order.paid for a single payment, and both must
  // collapse to one processing. Event-name-only keys would double-settle.
  const webhookEventId = req.headers['x-razorpay-event-id']
    || (payment?.id ? `pay_${payment.id}` : null)
    || crypto.createHash('sha256').update(`${req.body.event}_${req.body.created_at}_${orderId || 'no_id'}`).digest('hex');

  // IDEMPOTENCY: Check processed_webhook_events table
  try {
    const insertRes = await query(
      "INSERT INTO processed_webhook_events (event_id, payment_id, invoice_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [webhookEventId, payment?.id || null, receipt || null]
    );
    if (insertRes.rows.length === 0) {
      console.log(`[Webhook] Duplicate event ${webhookEventId} ignored.`);
      return res.status(200).send('Already processed');
    }
  } catch (err) {
    console.error('Webhook idempotency error:', err);
    throw err;
  }

  if (event === 'payment.captured' || event === 'order.paid') {
    // Locate the invoice strictly by order_id (which is anchored into tx_hash) OR by receipt.
    // Deterministic order: without ORDER BY, invoice_number collisions could settle the wrong row.
    const invRes = await query(
      'SELECT id, user_id, invoice_number, grand_total, status, tx_hash FROM invoices WHERE invoice_number = $1 OR tx_hash = $2 ORDER BY created_date DESC LIMIT 1',
      [receipt, orderId]
    );
    const inv = invRes.rows[0];

    if (!inv) {
      console.warn(`[WEBHOOK] ${event}: no invoice matches receipt='${receipt}' order='${orderId}'`);
      return res.json({ status: 'ok', note: 'invoice_not_found' });
    }

    // IDEMPOTENT NOOP: already paid invoices are never re-written — a replay
    // with a different payment.id must not overwrite the settled proof or
    // double-bump the campaign funnel.
    if (inv.status === 'paid') {
      return res.json({ status: 'ok', note: 'already_paid' });
    }

    // RELATIONSHIP BINDING GUARD: Ensure the webhook's orderId actually matches the orderId we generated (stored in tx_hash if not yet paid)
    if (inv.status !== 'paid' && inv.tx_hash !== orderId) {
      await appendAuditLog(inv.user_id, {
        action: 'webhook_relationship_mismatch',
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount: payment?.amount ? payment.amount / 100 : null,
        details: `CRITICAL: Webhook order_id (${orderId}) does not match invoice tx_hash (${inv.tx_hash}). Possible spoofing attempt.`
      });
      return res.json({ status: 'ok', note: 'relationship_mismatch' });
    }

    // AMOUNT GUARD: verify Razorpay's captured amount (paise) matches the invoice.
    // Tolerance is exactly ₹1 (100 paise): CGST/SGST half-split rounding can
    // legitimately drift by a rupee between order notes and stored totals.
    // Anything larger is a mismatch and the invoice is NOT marked paid.
    const PAISA_TOLERANCE = 100;
    if (!payment?.amount) {
      await appendAuditLog(inv.user_id, {
        action: 'webhook_amount_mismatch',
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount: null,
        details: `Webhook '${event}' carried no payment amount. Invoice NOT marked paid.`
      });
      return res.json({ status: 'ok', note: 'amount_missing' });
    }
    if (Math.abs(payment.amount - Math.round(Number(inv.grand_total) * 100)) > PAISA_TOLERANCE) {
      await appendAuditLog(inv.user_id, {
        action: 'webhook_amount_mismatch',
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount: payment.amount / 100,
        details: `Webhook amount ${(payment.amount / 100).toFixed(2)} != invoice ${Number(inv.grand_total).toFixed(2)} (tolerance ₹1). Invoice NOT marked paid.`
      });
      return res.json({ status: 'ok', note: 'amount_mismatch' });
    }

    await query(
      "UPDATE invoices SET status = 'paid', tx_hash = $1, payment_method = 'razorpay_webhook', updated_date = NOW() WHERE id = $2",
      [payment?.id || inv.tx_hash, inv.id]
    );

    // Closed-loop: if this invoice was generated by a campaign, count the paid
    // conversion so the Campaign Orchestrator funnel reflects real revenue.
    await bumpCampaignForInvoice(inv.id, 'paid');

    await appendAuditLog(inv.user_id, {
      action: 'settlement_captured',
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      amount: inv.grand_total,
      tx_hash: payment?.id,
      details: `Webhook '${event}' verified (HMAC OK). Razorpay confirmed capture of payment ${payment?.id} for order ${orderId}.`
    });

    console.log(`[WEBHOOK] Invoice ${inv.invoice_number} settled via ${event}: ${payment?.id}`);
    return res.json({ status: 'ok' });
  }

  if (event === 'payment.failed') {
    if (receipt) {
      const invRes = await query('SELECT id, user_id, invoice_number, grand_total FROM invoices WHERE invoice_number = $1', [receipt]);
      const inv = invRes.rows[0];
      if (inv) {
        await appendAuditLog(inv.user_id, {
          action: 'settlement_failed',
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          amount: inv.grand_total,
          details: `Webhook 'payment.failed': ${payment?.error_description || 'payment did not complete'}.`
        });
      }
    }
  }

  res.json({ status: 'ok' });
});

// --- LLM ---
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

// Load the machine-readable catalog so the LLM can reason over REAL products
// (prices, tags, descriptions) instead of hallucinating upsells.
import fs from 'fs';
function loadAgentCatalog() {
  for (const p of ['../public/.well-known/agent-catalog.json', 'public/.well-known/agent-catalog.json']) {
    try {
      const raw = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
      // Strip BOM if present — JSON.parse rejects a leading \uFEFF
      return JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch { /* try next */ }
  }
  return null;
}
const AGENT_CATALOG = loadAgentCatalog();

function normalizeInvoiceResponse(data) {
  if (data && typeof data === 'object' && ('score' in data || 'passed' in data)) {
    const score = Number(data.score ?? (data.passed ? 90 : 40));
    return { passed: score >= 85, score, issues: data.issues || [] };
  }

  // Handle LLMs that wrap the response in {"invoice": {...}}
  if (data && data.invoice && typeof data.invoice === 'object') {
    data = data.invoice;
  }

  const out = {};
  out.institution_name = data.institution_name || data.seller?.name || data.vendor?.name || data.from?.name || data.institutionName || '';
  out.institution_address = data.institution_address || data.seller?.address || data.vendor?.address || data.from?.address || '';
  out.gst_number = data.gst_number || data.gstin || data.gst || data.seller?.gstin || data.seller?.gst_number || '';
  out.recipient_name = data.recipient_name || data.buyer?.name || data.customer?.name || data.client?.name || data.to?.name || data.recipientName || '';
  out.recipient_address = data.recipient_address || data.buyer?.address || data.customer?.address || data.client?.address || data.to?.address || '';
  out.recipient_gst = data.recipient_gst || data.buyer?.gstin || data.customer?.gstin || '';

  const rawItems = data.line_items || data.items || data.products || data.services || [];
  out.line_items = rawItems.map(item => ({
    description: item.description || item.name || item.product || item.service || '',
    quantity: item.quantity ?? item.qty ?? 1,
    unit_price: item.unit_price ?? item.unitPrice ?? item.price ?? item.rate ?? 0,
    tax_rate: item.tax_rate ?? item.taxRate ?? item.gst_rate ?? item.gst ?? 18,
    total: (item.quantity ?? item.qty ?? 1) * (item.unit_price ?? item.unitPrice ?? item.price ?? item.rate ?? 0),
  }));

  // BUGFIX: Force strict mathematical calculations to prevent LLM arithmetic hallucinations
  out.subtotal = out.line_items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0);
  out.tax_total = out.line_items.reduce((sum, it) => sum + (it.quantity * it.unit_price * (it.tax_rate / 100)), 0);
  out.grand_total = out.subtotal + out.tax_total;

  out.currency = data.currency || data.invoice_details?.currency || 'INR';
  // Force the current date to prevent LLM hallucinating past dates (e.g. 2023)
  out.invoice_date = new Date().toISOString().split('T')[0];
  out.due_date = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  // Validate GSTIN format deterministically server-side
  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  out.ai_suggestions = data.ai_suggestions || data.suggestions || data.issues || [];

  if (out.recipient_gst && !gstRegex.test(out.recipient_gst)) {
    out.ai_suggestions.push({
      field: "recipient_gst",
      issue: "CRITICAL: Invalid GSTIN Format detected by deterministic scan",
      suggestion: "The AI generated an invalid GST number. It must follow standard 15-char format (e.g. 07AAACN0372J1ZB).",
      severity: "critical"
    });
  }

  return out;
}

async function callMistralAPI(prompt, schema) {
  const schemaHint = schema ? `\n\nReturn ONLY a flat JSON object matching this structure:\n${JSON.stringify(schema, null, 2)}` : '';
  const messages = [
    { role: 'system', content: 'You are an AI B2B Commerce expert. Return ONLY valid JSON. Use Indian GST format, INR currency, and realistic B2B enterprise details.' + schemaHint },
    { role: 'user', content: prompt },
  ];

  const body = {
    model: MISTRAL_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 2500,
  };

  // Don't use response_format:json_object — many free models don't support it.
  // The system prompt already instructs JSON-only output, and handleResponse
  // strips markdown code fences before parsing.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return await handleResponse(res);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// --- Dynamic Catalog Management ---
app.get('/api/catalog', async (req, res) => {
  try {
    const products = await query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(products.rows);
  } catch (err) {
    res.status(500).json({ error: 'catalog_error', message: err.message });
  }
});

app.post('/api/catalog', authMiddleware, async (req, res) => {
  const { name, description, price, margin_floor, sku, hsn_code } = req.body;
  // Catalog rows feed the margin-floor gate: NaN/negative floors disable it
  // (price < NULL is falsy), and missing SKUs make products unquotable.
  if (!name || typeof name !== 'string' || name.length > 200) {
    return res.status(400).json({ error: 'invalid_name', message: 'Product name (max 200 chars) is required.' });
  }
  const priceN = Number(price), floorN = Number(margin_floor);
  if (!Number.isFinite(priceN) || priceN < 0 || priceN > 99999999.99) {
    return res.status(400).json({ error: 'invalid_price', message: 'price must be a finite non-negative number.' });
  }
  if (!Number.isFinite(floorN) || floorN < 0 || floorN > priceN) {
    return res.status(400).json({ error: 'invalid_margin_floor', message: 'margin_floor must be between 0 and price.' });
  }
  const skuV = (sku && String(sku)) || ('sku_' + crypto.randomUUID().slice(0, 8));
  const id = crypto.randomUUID();
  try {
    await query(
      'INSERT INTO products (id, user_id, sku, name, description, price, margin_floor, hsn_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, req.user.id, skuV, name, description || null, priceN, floorN, hsn_code || null]
    );
    res.json({ success: true, id, sku: skuV });
  } catch (err) {
    res.status(500).json({ error: 'catalog_error', message: err.message });
  }
});

app.delete('/api/catalog/:id', authMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM products WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'catalog_error', message: err.message });
  }
});

// --- Chat Transcripts ---
app.get('/api/chat/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await query(
      "SELECT id, buyer_name, updated_at AT TIME ZONE 'UTC' as updated_at, jsonb_array_length(messages) as message_count FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC",
      [req.user.id]
    );
    res.json(sessions.rows);
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.get('/api/chat/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const sessions = await query('SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json(sessions.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.delete('/api/chat/sessions/:id', authMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.post('/api/chat/sync', authMiddleware, async (req, res) => {
  // Authenticated + strictly scoped: a session belongs to exactly one user.
  // Previously any unauthenticated caller could overwrite any session_id and
  // the orphan rows were attributed to merchant #1.
  const { session_id, messages, buyer_name } = req.body;
  if (!session_id || typeof session_id !== 'string' || session_id.length > 128) {
    return res.status(400).json({ error: 'bad_request', message: 'valid session_id is required' });
  }
  if (!Array.isArray(messages) || messages.length > 500) {
    return res.status(400).json({ error: 'bad_request', message: 'messages must be an array (max 500 turns)' });
  }
  try {
    const existing = await query('SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2', [session_id, req.user.id]);
    if (existing.rows.length > 0) {
      await query('UPDATE chat_sessions SET messages = $1, buyer_name = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4', [JSON.stringify(messages), buyer_name || null, session_id, req.user.id]);
    } else {
      await query('INSERT INTO chat_sessions (id, user_id, buyer_name, messages) VALUES ($1, $2, $3, $4)', [session_id, req.user.id, buyer_name || null, JSON.stringify(messages)]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

async function handleResponse(res) {

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Mistral API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in response');
  
  // Robust JSON extraction to ignore "Here is your JSON: ..." wrappers
  const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    content = jsonMatch[0];
  } else {
    content = content.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error("Failed to parse LLM JSON:", content);
    throw new Error("AI returned invalid JSON format.");
  }
}

// NOTE: The old generateMockInvoice() / MOCK_VALIDATION fake-AI helpers were
// removed on purpose. See the fail-loud /api/llm/invoke handler below.

app.post('/api/llm/invoke', authMiddleware, async (req, res) => {
  const { prompt, response_json_schema } = req.body;

  // FAIL-LOUD (the silent mock fallback was removed): if Mistral is not
  // configured we return an explicit error instead of inventing an invoice or
  // claiming validation passed. An honest "AI is off" beats a fake "AI said OK".
  if (!MISTRAL_API_KEY) {
    console.warn('[FAIL-LOUD] MISTRAL_API_KEY not set — refusing to fake AI output.');
    return res.status(503).json({
      error: 'ai_not_configured',
      message: 'AI is not configured: set MISTRAL_API_KEY in your environment. No mocked invoice or validation was returned.',
      demo_mode: true,
    });
  }

  try {
    const parsed = await callMistralAPI(prompt, response_json_schema);
    return res.json(normalizeInvoiceResponse(parsed));
  } catch (err) {
    console.error('[FAIL-LOUD] Mistral call failed — no canned fallback:', err.message);
    return res.status(502).json({
      error: 'ai_unavailable',
      message: 'The AI service was unavailable. No canned/mocked result was substituted.',
      demo_mode: true,
    });
  }
});

// --- Conversational AI Checkout Agent (Tier 2) ---
app.post('/api/agent/chat', authMiddleware, async (req, res) => {
  if (await getOpsFlag('llm_disabled')) {
    return res.status(503).json({
      error: 'agent_ai_disabled',
      message: 'The autonomous agent is halted by the ops kill-switch (llm_disabled). Manual catalog ordering is enabled below — or restore autonomous mode from the Manual Checkout panel.',
      demo_mode: true,
      fallback_mode: true,
      simulated: true,
      catalog: AGENT_CATALOG.catalog,
      bundles: AGENT_CATALOG.bundles,
    });
  }
  const { messages } = req.body;

  const tools = [
    {
      type: "function",
      function: {
        name: "search_catalog",
        description: "Search for available products or services to buy.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      }
    },
    {
      type: "function",
      function: {
        name: "suggest_upsell_bundle",
        description: "Recommend ONE complementary product from the merchant catalog that genuinely fits the customer's purchase, with a concrete business reason. Use the catalog provided in your instructions.",
        parameters: {
          type: "object",
          properties: {
            original_item: { type: "string" },
            user_budget_cap: { type: "number", description: "The total budget or mandate limit the user stated, e.g. 25000" },
            total_cost_of_original_items: { type: "number", description: "The total cost of the original items plus any previously accepted upsells" },
            remaining_headroom: { type: "number", description: "user_budget_cap minus total_cost_of_original_items" },
            recommended_item: { type: "string", description: "The exact product name from the catalog. Its price MUST be strictly less than or equal to remaining_headroom." },
            reason: { type: "string", description: "One or two sentences explaining WHY this complement adds value (technical fit, compliance, cost of NOT having it, etc.)." }
          },
          required: ["original_item", "user_budget_cap", "total_cost_of_original_items", "remaining_headroom", "recommended_item", "reason"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_invoice",
        description: "Create a new invoice for the user's requested items.",
        parameters: { 
          type: "object", 
          properties: { 
            line_items: {
              type: "array",
              description: "The list of items to include in the invoice.",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string", description: "The product SKU from the catalog" },
                  quantity: { type: "number", description: "Quantity of this item" },
                  negotiated_price: { type: "number", description: "The negotiated unit price for this product, if different from the list price. The server will reject it if below margin_floor." }
                },
                required: ["sku", "quantity"]
              }
            },
            is_ai_upsell: { type: "boolean", description: "Set to true ONLY IF one or more items are being purchased because YOU suggested it via an upsell." }
          }, 
          required: ["line_items"] 
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_invoice",
        description: "Modify an existing draft invoice with new line items (e.g., if the user changes the quantity or adds/removes products). This prevents creating duplicate drafts.",
        parameters: {
          type: "object",
          properties: {
            invoice_id: { type: "string", description: "The ID of the invoice to update." },
            line_items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string", description: "The product SKU from the catalog" },
                  quantity: { type: "number", description: "Quantity" },
                  negotiated_price: { type: "number" }
                },
                required: ["sku", "quantity"]
              }
            }
          },
          required: ["invoice_id", "line_items"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "cancel_invoice",
        description: "Delete or cancel a draft invoice if the user changes their mind and wants to discard it.",
        parameters: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] }
      }
    },
    {
      type: "function",
      function: {
        name: "trigger_payment",
        description: "Trigger the Razorpay checkout process for a specific invoice ID to settle it autonomously.",
        parameters: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] }
      }
    }
  ];

  // FAIL-LOUD (v2): the old keyword-based "demo mode" fallback was removed.
  if (!MISTRAL_API_KEY) {
    console.warn('[FAIL-LOUD] /api/agent/chat refused: MISTRAL_API_KEY not set — no canned tool calls.');
    return res.status(503).json({
      error: 'agent_ai_not_configured',
      message: 'The autonomous agent is disabled: set MISTRAL_API_KEY to enable agentic chat. No simulated invoice or payment tool call was returned.',
      demo_mode: true,
      fallback_mode: true,
      catalog: AGENT_CATALOG.catalog,
      bundles: AGENT_CATALOG.bundles,
    });
  }

  try {
    const productsRes = await query('SELECT sku, name, description, price, margin_floor FROM products');
    const dynamicCatalog = productsRes.rows;
    const catalogContext = dynamicCatalog.length > 0
      ? `\n\nMERCHANT CATALOG (real products, real prices — only recommend items from this list):\n${JSON.stringify(dynamicCatalog, null, 2)}`
      : '\n\nMERCHANT CATALOG is currently empty. Ask the user to add products via the Merchant Portal.';

    // Inject the real backend mandate limits into the LLM's brain so the user doesn't even have to state it!
    const userRes = await query('SELECT agent_delegation_max, agent_daily_limit, agent_daily_spent FROM users WHERE id = $1', [req.user.id]);
    const userRow = userRes.rows[0] || {};
    const delegationMax = userRow.agent_delegation_max || 0;
    const dailyLimit = userRow.agent_daily_limit || 0;
    const dailySpent = userRow.agent_daily_spent || 0;
    
    let mandateContext = `\n\nUSER'S ACTIVE CFO MANDATE:\nThe backend reports this user does NOT have an active autonomous budget delegation set up. Any payment you try to trigger will escalate to a human.`;
    if (delegationMax > 0) {
      mandateContext = `\n\nUSER'S ACTIVE CFO MANDATE:\nThe backend reports that this user has an active autonomous budget delegation:
- Per-Transaction Limit: ₹${delegationMax}
- Daily Limit: ₹${dailyLimit} (₹${dailySpent} already spent today)
This means you must treat ₹${Math.min(delegationMax, dailyLimit - dailySpent)} as their ABSOLUTE MAXIMUM budget for this conversation, even if they don't explicitly mention it. DO NOT recommend upsells that cause the total cart to exceed this calculated budget cap.`;
    }

    const body = {
      model: MISTRAL_MODEL,
      messages: [
        { role: "system", content: `You are AgentPay Gateway — a senior enterprise sales engineer for Razorpay. Your dual objective: maximise the merchant's realised margin on every transaction AND ensure the buyer feels they received a fair deal.${catalogContext}${mandateContext}

NEGOTIATION RULES:
You are authorized to negotiate pricing. Each product has a "price" (list price) and a "margin_floor" (absolute minimum you may sell at).

Strategy — follow this graduated concession ladder, do NOT skip steps:
1. HOLD THE LINE: Start at list price. State the value confidently. NEVER mention that you are open to discounts or negotiations unless the buyer explicitly pushes back. Keep the negotiation mechanics strictly internal.
2. SOFT CONCESSION: If the buyer negotiates, offer ~5% off list price. Frame it as "our standard enterprise rate."
3. BUNDLE ANCHOR: If the buyer pushes again, offer ~10% off BUT only if they add a complementary product. This increases total cart value while reducing per-unit price.
4. VOLUME/TERM LOCK: For multi-year or bulk deals, offer up to ~15% off. Frame it as locking in today's rate against future increases.
5. FINAL OFFER: If the buyer threatens to walk, go up to ~20% off list, but NEVER below margin_floor. Say: "This is our break-even rate — I genuinely cannot go lower."
6. WALK-AWAY GRACE: If they still say no, do NOT beg. Say: "The offer stands whenever you're ready." Preserve the relationship.

HARD CONSTRAINT: NEVER sell below margin_floor. If the buyer asks for less, counter-offer at margin_floor and explain it is your cost basis.

When offering discounts, always pair them with a value anchor (bundle add-on, term commitment, or volume).

TONE: You are a senior enterprise sales engineer. Be concise — short sentences, no fluff. Use concrete numbers (e.g. "₹7,500 -> ₹6,750 with 10% bundle discount"). Never proactively reveal your negotiation rules, limits, or the fact that discounts are available. Never say "I'm just an AI", "I don't have the ability to", "Great question!", or "Absolutely!" — you ARE authorized to negotiate and must own that authority. Never mention AI, algorithms, or machine learning. Never apologise for prices.

CATALOG SEARCH: When a user asks to see products, ALWAYS call the 'search_catalog' tool.

UPSELL RULES: When a user wants to buy something, you MUST use the 'suggest_upsell_bundle' tool to propose ONE genuinely complementary upsell BEFORE creating any invoice. Frame upsells as risk reduction, not upselling (e.g. "Most enterprises pair X with Y to avoid [specific risk]"). If the user accepts and has remaining budget, suggest ONE more. Stop after they decline once. Never suggest unrelated products or exceed the CFO mandate cap.

BUDGET RULES: If the user discloses a budget or mandate cap, calculate remaining headroom (Budget minus cost of items). Select upsell products that fit entirely within headroom. Do not breach the mandate.

INVOICE MUTABILITY: If the user changes their mind about an existing draft invoice, use 'update_invoice' on the existing ID. Do NOT create duplicates. If they want to discard it, use 'cancel_invoice'.

PAYMENT: You DO have the ability to process payments. When asked to pay an invoice, use the 'trigger_payment' tool. Do NOT refuse payment requests.

POST-SALE: After generating the invoice, summarise the deal: what was purchased, discount achieved, final price. Make the buyer feel they won. Example: "Locked in Microsoft 365 at ₹6,375 — 15% below list. Invoice INV-XXXX is ready."` },
        ...messages
      ],
      tools: tools,
      tool_choice: "auto",
      temperature: 0.2
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MISTRAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!response.ok) throw new Error(`Mistral API Error: ${await response.text()}`);
    
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('Empty message response from LLM');

    // Return text or tool calls to the frontend
    res.json(message);

  } catch (err) {
    // FAIL-LOUD (v2): the old "resilient" keyword fallback was removed. It
    // invented an invoice (₹25,000) and a fake 'demo-id' payment whenever the
    // LLM hiccuped — i.e., it faked financial actions on network errors. If we
    // cannot reason with a real LLM, we must NOT guess with string matching
    // about money. Surface the failure honestly instead.
    console.error('[FAIL-LOUD] /api/agent/chat failed — no canned fallback:', err.message);
    return res.status(502).json({
      error: 'agent_ai_unavailable',
      message: 'The agent LLM was unavailable. No simulated invoice or payment tool call was returned. Please retry.',
      demo_mode: true,
      fallback_mode: true,
      catalog: AGENT_CATALOG.catalog,
      bundles: AGENT_CATALOG.bundles,
    });
  }
});

// --- App Settings ---
app.get('/api/apps/public/prod/public-settings/by-id/:appId', async (req, res) => {
  const result = await query('SELECT * FROM app_settings WHERE id = $1', [req.params.appId]);
  if (result.rows.length > 0) {
    const row = result.rows[0];
    return res.json({ ...row, public_settings: typeof row.public_settings === 'string' ? JSON.parse(row.public_settings) : row.public_settings });
  }
  res.json({ id: req.params.appId, public_settings: {} });
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
});

function parseInvoice(row) {
  if (!row) return null;
  return {
    ...row,
    // node-postgres returns NUMERIC(12,2) as strings — coerce at the boundary
    // so every consumer can do arithmetic without string-concat NaN bugs.
    subtotal: row.subtotal == null ? 0 : Number(row.subtotal),
    tax_total: row.tax_total == null ? 0 : Number(row.tax_total),
    grand_total: row.grand_total == null ? 0 : Number(row.grand_total),
    compliance_score: row.compliance_score == null ? row.compliance_score : Number(row.compliance_score),
    line_items: safeJson(row.line_items, []),
    ai_suggestions: safeJson(row.ai_suggestions, []),
    milestones: safeJson(row.milestones, []),
  };
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return fallback; }
}

// Local dev server
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

export default app;

