import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, initDb } from './_db.js';
import { generateToken, authMiddleware } from './_auth.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

import 'express-async-errors';

const app = express();

export async function appendAuditLog(userId, data) {
  const id = uuidv4();
  
  // 1. Get previous hash for the chain
  const lastLog = await query(
    'SELECT hash FROM audit_logs WHERE user_id = $1 ORDER BY created_date DESC LIMIT 1',
    [userId]
  );
  const prev_hash = lastLog.rows.length > 0 && lastLog.rows[0].hash ? lastLog.rows[0].hash : '0'.repeat(64);
  
  // 2. Compute SHA-256 of payload + prev_hash
  const timestamp = data.created_date || new Date().toISOString();
  const payload = JSON.stringify({
    user_id: userId,
    action: data.action,
    invoice_id: data.invoice_id || null,
    amount: data.amount || null,
    prev_hash: prev_hash,
    timestamp: timestamp
  });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  // 3. Store hash and prev_hash
  await query(`
    INSERT INTO audit_logs (id, user_id, action, invoice_id, invoice_number, amount,
      agent_address, owner_address, tx_hash, details, created_date, hash, prev_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [
    id, userId, data.action, data.invoice_id || null, data.invoice_number || null,
    data.amount || null, data.agent_address || null, data.owner_address || null, data.tx_hash || null, data.details,
    timestamp, hash, prev_hash
  ]);

  return id;
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

  const lineItems = invoice.line_items || [];
  
  for (const item of lineItems) {
    if (!item.sku || !mandate.sku_allowlist.includes(item.sku)) {
      return {
        status: 403,
        body: {
          error: 'agent_out_of_bounds',
          reason: 'sku_not_in_mandate',
          message: `SKU '${item.sku || 'UNKNOWN'}' is not in the buyer's approved mandate allowlist.`,
        },
        audit: {
          action: 'settlement_blocked',
          amount: invoice.grand_total,
          details: `Blocked: SKU '${item.sku}' not in mandate allowlist.`,
        }
      };
    }
  }

  return null; // Passes the mandate
}

async function enforceBudget(userId, amount, delegation_max) {
  const today = new Date().toISOString().slice(0, 10);
  const userRes = await query(
    `SELECT agent_daily_limit, agent_daily_spent, daily_reset_date
     FROM users WHERE id = $1 FOR UPDATE`,
    [userId]
  );
  const u = userRes.rows[0] || {};
  const dailyLimit = Number(u.agent_daily_limit || 0);
  let dailySpent = Number(u.agent_daily_spent || 0);
  const resetDate = u.daily_reset_date;

  // Auto-reset the daily counter at midnight — important so the limit isn't
  // a one-way ratchet that locks out the merchant after day one.
  if (resetDate !== today) {
    dailySpent = 0;
    await query(
      'UPDATE users SET agent_daily_spent = 0, daily_reset_date = $1 WHERE id = $2',
      [today, userId]
    );
  }

  if (amount > delegation_max) {
    return {
      status: 403,
      body: {
        error: 'budget_exceeded',
        reason: 'per_transaction',
        message: `Transaction ₹${amount} exceeds autonomous per-transaction delegation ₹${delegation_max}.`,
      },
      audit: {
        action: 'settlement_blocked',
        amount,
        details: `Blocked: ₹${amount} > per-transaction delegation ₹${delegation_max}.`,
      }
    };
  }

  if (dailyLimit > 0 && dailySpent + amount > dailyLimit) {
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

  // Reservation: bump the counter so concurrent requests cannot both pass.
  await query(
    'UPDATE users SET agent_daily_spent = agent_daily_spent + $1 WHERE id = $2',
    [amount, userId]
  );
  return null;
}

/** Refund a previously-reserved amount back to the daily counter (used on error). */
async function refundBudget(userId, amount) {
  try {
    await query(
      'UPDATE users SET agent_daily_spent = GREATEST(agent_daily_spent - $1, 0) WHERE id = $2',
      [amount, userId]
    );
  } catch (e) {
    console.error('[BUDGET] refund failed:', e?.message);
  }
}

/**
 * Closed-loop campaign attribution: when an invoice tied to a campaign moves
 * to a more-advanced state, increment the corresponding counter so the
 * campaign funnel stays truthful. Idempotent (the campaign.paid column only
 * gets +1 once per invoice via a guarded subquery).
 */
async function bumpCampaignForInvoice(invoiceId, kind) {
  if (!invoiceId) return;
  try {
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

    res.json({ success: true, message: 'Verification code sent to email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'validation_error', message: 'Email required' });

    const result = await query('SELECT id, email, name, role FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'User not found' });

    await query('UPDATE users SET is_verified = 1, updated_at = NOW() WHERE email = $1', [email]);
    const user = result.rows[0];
    const token = generateToken(user);

    res.json({ access_token: token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/resend-otp', (req, res) => res.json({ success: true }));
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
    `SELECT * FROM invoices WHERE user_id = $1 ORDER BY ${safeField} ${dir} LIMIT $2`,
    [req.user.id, limit]
  );

  res.json(result.rows.map(parseInvoice));
});

app.get('/api/invoices/:id', authMiddleware, async (req, res) => {
  const result = await query('SELECT * FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [req.params.id, req.user.id]);
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
  let subtotal = data.subtotal;
  let tax_total = data.tax_total;
  let grand_total = data.grand_total;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const calcSubtotal = lineItems.reduce((s, it) => s + Number(it.quantity ?? it.qty ?? 1) * Number(it.unit_price ?? it.price ?? it.rate ?? 0), 0);
    const calcTax = lineItems.reduce((s, it) => {
      const base = Number(it.quantity ?? it.qty ?? 1) * Number(it.unit_price ?? it.price ?? it.rate ?? 0);
      return s + base * (Number(it.tax_rate ?? it.taxRate ?? 18) / 100);
    }, 0);
    // Use calculated values when caller sent 0/undefined or mismatched (agent case)
    if (!subtotal || Math.abs(subtotal - calcSubtotal) > 0.01) subtotal = calcSubtotal;
    if (tax_total == null || Math.abs(tax_total - calcTax) > 0.01) tax_total = Math.round(calcTax);
    const calcGrand = subtotal + tax_total;
    if (!grand_total || Math.abs(grand_total - calcGrand) > 0.01) grand_total = calcGrand;
    // Normalize line_items totals to qty*unit_price
    lineItems = lineItems.map(it => ({
      ...it,
      quantity: Number(it.quantity ?? it.qty ?? 1),
      unit_price: Number(it.unit_price ?? it.price ?? it.rate ?? 0),
      tax_rate: Number(it.tax_rate ?? it.taxRate ?? 18),
      total: Number(it.quantity ?? it.qty ?? 1) * Number(it.unit_price ?? it.price ?? it.rate ?? 0),
    }));
  }
  const today = new Date().toISOString().split('T')[0];
  const dueDefault = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  // --- Margin Floor Guardrail ---
  const products = await query('SELECT name, margin_floor FROM products');
  let complianceScore = data.compliance_score || null;
  const aiSuggestions = data.ai_suggestions || [];
  let status = data.status || 'draft';

  for (const item of lineItems) {
    const matchedProduct = products.rows.find(p => item.description?.toLowerCase().includes(p.name.toLowerCase()));
    if (matchedProduct) {
      if (item.unit_price < matchedProduct.margin_floor) {
        complianceScore = 0;
        status = 'draft';
        aiSuggestions.push({
          field: 'line_items',
          issue: 'CRITICAL: Margin floor violation',
          suggestion: `Agent attempted to sell ${matchedProduct.name} at ₹${item.unit_price}, which is below the margin floor of ₹${matchedProduct.margin_floor}. Escalated to human review.`,
          severity: 'critical'
        });
      }
    }
  }

  await query(`
    INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address,
      gst_number, recipient_name, recipient_address, recipient_gst, line_items, subtotal,
      tax_total, grand_total, currency, status, compliance_score, ai_suggestions,
      invoice_date, due_date, milestones, is_ai_upsell)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
  `, [
    id, req.user.id,
    data.invoice_number || `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
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
  const exists = await query('SELECT id FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const internalId = exists.rows[0].id;

  const data = req.body;
  const sets = [];
  const params = [];
  let i = 1;

  const ALLOWED_UPDATE_FIELDS = new Set([
    'invoice_number', 'institution_name', 'institution_address', 'gst_number',
    'recipient_name', 'recipient_address', 'recipient_gst', 'line_items',
    'subtotal', 'tax_total', 'grand_total', 'currency', 'compliance_score',
    'ai_suggestions', 'invoice_date', 'due_date', 'milestones', 'cid',
    'tx_hash', 'payment_method', 'status'
  ]);

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    
    let processedValue = value;
    if (key === 'line_items') {
      const products = await query('SELECT name, margin_floor FROM products');
      const items = typeof value === 'string' ? JSON.parse(value) : value;
      for (const item of items) {
        const matchedProduct = products.rows.find(p => item.description?.toLowerCase().includes(p.name.toLowerCase()));
        if (matchedProduct && item.unit_price < matchedProduct.margin_floor) {
          data.compliance_score = 0;
          data.status = 'draft';
          data.ai_suggestions = data.ai_suggestions || [];
          data.ai_suggestions.push({
            field: 'line_items',
            issue: 'CRITICAL: Margin floor violation during update',
            suggestion: `Agent attempted to update ${matchedProduct.name} to ₹${item.unit_price}, which is below the margin floor of ₹${matchedProduct.margin_floor}. Escalated to human review.`,
            severity: 'critical'
          });
        }
      }
      processedValue = items;
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

  // Closed-loop: draft → validated is a campaign "acceptance".
  if (data.status === 'validated' && updated.status === 'validated') {
    await bumpCampaignForInvoice(internalId, 'accepted');
  }
  // Closed-loop: any → paid is a campaign "conversion".
  if (data.status === 'paid' && updated.status === 'paid') {
    await bumpCampaignForInvoice(internalId, 'paid');
  }

  res.json(parseInvoice(updated));
});

app.delete('/api/invoices/:id', authMiddleware, async (req, res) => {
  const exists = await query('SELECT id FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
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
    `SELECT id, user_id, action, invoice_id, amount, prev_hash, hash, created_date::text AS created_ts
     FROM audit_logs WHERE user_id = $1 ORDER BY created_date ASC, id ASC`,
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

    // 2. Recompute the hash of the current payload
    const payload = JSON.stringify({
      user_id: log.user_id,
      action: log.action,
      invoice_id: log.invoice_id || null,
      amount: log.amount || null,
      prev_hash: log.prev_hash,
      timestamp: toUtcIso(log.created_ts)
    });
    const computedHash = crypto.createHash('sha256').update(payload).digest('hex');

    // 3. Verify it matches the stored hash
    if (computedHash !== log.hash) {
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

import { createAgentSettlementOrder, captureAutonomousPayment, verifyWebhookSignature, verifySignature, isRazorpayConfigured, computeTaxSplit } from './razorpay.js';

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
  const { product_id, quantity = 1 } = req.body;

  // 1. Validate Product — against the REAL machine-readable catalog
  const product = AGENT_CATALOG?.catalog?.find(p => p.id === product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const subtotal = product.price * quantity;
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
    INSERT INTO invoices (id, user_id, invoice_number, recipient_name, line_items, subtotal, tax_total, grand_total, currency, status, tx_hash, invoice_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    invoiceId, merchant.id, invoiceNumber, `AI Buyer Agent (${req.user.email})`,
    JSON.stringify([{ description: product.name, quantity, price: product.price, total: subtotal }]),
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

// Standard human checkout (bypasses agent bounds/compliance checks)
app.post('/api/checkout/order', authMiddleware, async (req, res) => {
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'bad_request', message: 'invoice_id is required' });

  const invRes = await query('SELECT * FROM invoices WHERE id = $1', [invoice_id]);
  if (invRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invRes.rows[0];

  if (invoice.status === 'paid') return res.status(409).json({ error: 'already_paid', message: 'Invoice already paid' });

  try {
    const { order } = await createAgentSettlementOrder(invoice.grand_total, invoice.invoice_number, invoice.tax_total || 0, invoiceTaxSplit(invoice));
    res.json({ order_id: order.id, amount: Math.round(invoice.grand_total * 100), currency: invoice.currency || 'INR' });
  } catch (err) {
    res.status(500).json({ error: 'order_failed', message: err.message });
  }
});

// The buyer agent completes the 402 challenge: pays the merchant's order S2S.
app.post('/api/agent/b2b-pay', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  const { invoice_id, order_id } = req.body;
  if (!invoice_id || !order_id) {
    return res.status(400).json({ error: 'bad_request', message: 'invoice_id and order_id (from the 402 challenge) are required.' });
  }

  // The challenge must match: invoice exists AND was anchored to THIS order
  const invRes = await query('SELECT * FROM invoices WHERE id = $1 AND tx_hash = $2', [invoice_id, order_id]);
  if (invRes.rows.length === 0) {
    return res.status(404).json({ error: 'challenge_not_found', message: 'No matching 402 challenge for this invoice/order pair.' });
  }
  const invoice = invRes.rows[0];

  // Idempotency: an already-paid challenge cannot be replayed
  if (invoice.status === 'paid') {
    return res.status(409).json({ error: 'already_settled', message: 'This challenge has already been paid.', payment_id: invoice.tx_hash });
  }

  // ATOMIC CLAIM so two buyer agents cannot double-pay one challenge
  const claim = await query(
    `UPDATE invoices SET status = 'processing', updated_date = NOW()
     WHERE id = $1 AND status NOT IN ('paid', 'processing') RETURNING id`,
    [invoice.id]
  );
  if (claim.rows.length === 0) {
    return res.status(409).json({ error: 'already_processing', message: 'Challenge is being settled by another request.' });
  }

  try {
    const settlement = await captureAutonomousPayment(order_id, invoice.grand_total);

    if (settlement.mode === 'mandate_captured') {
      // Money moved — Razorpay-verified capture
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
        details: `Buyer agent completed the 402 challenge: paid ${settlement.payment.id} to merchant.`
      });

      return res.json({
        success: true,
        payment_protocol: 'x402_razorpay',
        order_id,
        payment_id: settlement.payment.id,
        status: 'captured'
      });
    }

    // Buyer agent has no mandate token — the challenge stays open, a real
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
    // Release the claim so the challenge stays retryable
    await query("UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1 AND status = 'processing'", [invoice.id]);
    console.error('x402 payment error:', err);
    return res.status(500).json({ error: 'payment_error', message: err.message });
  }
});



// --- Razorpay Agentic Commerce ---
app.post('/api/agent/settle', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  const { invoice_id } = req.body;
  const userRes = await query('SELECT agent_delegation_max FROM users WHERE id = $1', [req.user.id]);
  const delegation_max = userRes.rows[0]?.agent_delegation_max || 0;

  // Allow lookup by either UUID or human-readable invoice_number
  const invoiceRes = await query('SELECT * FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [invoice_id, req.user.id]);
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
     WHERE (id = $1 OR invoice_number = $1) AND user_id = $2 AND status NOT IN ('paid', 'processing')
     RETURNING id`,
    [invoice_id, req.user.id]
  );
  if (claim.rows.length === 0) {
    return res.status(409).json({
      error: 'already_settled',
      message: `Invoice ${invoice.invoice_number} is already settled or being processed by another request.`
    });
  }

  try {
    // Feature 2: Razorpay Route split payment (taxes)
    const taxAmount = invoice.tax_total || 0;
    const { order } = await createAgentSettlementOrder(invoice.grand_total, invoice.invoice_number, taxAmount, invoiceTaxSplit(invoice));
    
    await query('UPDATE invoices SET status = $1 WHERE id = $2 AND user_id = $3', ['pending', invoice.id, req.user.id]);

    await appendAuditLog(req.user.id, {
      action: 'order_created',
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      amount: invoice.grand_total,
      details: `Razorpay Order ${order.id} generated autonomously.`
    });

    res.json({ success: true, order, invoice_uuid: invoice.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'payment_error', message: 'Failed to create Razorpay Order' });
  }
});

app.post('/api/agent/auto-settle', authMiddleware, agentSettleRateLimiter, async (req, res) => {
  const { invoice_id } = req.body;
  const userRes = await query('SELECT agent_delegation_max, razorpay_customer_id, razorpay_token_id FROM users WHERE id = $1', [req.user.id]);
  const delegation_max = userRes.rows[0]?.agent_delegation_max || 0;
  const { razorpay_customer_id, razorpay_token_id } = userRes.rows[0] || {};

  // Allow lookup by either UUID or human-readable invoice_number
  const invoiceRes = await query('SELECT * FROM invoices WHERE (id = $1 OR invoice_number = $1) AND user_id = $2', [invoice_id, req.user.id]);
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
     WHERE (id = $1 OR invoice_number = $1) AND user_id = $2 AND status NOT IN ('paid', 'processing')
     RETURNING id`,
    [invoice_id, req.user.id]
  );
  if (claim.rows.length === 0) {
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
      await query('UPDATE invoices SET status = $1, tx_hash = $2 WHERE id = $3 AND user_id = $4', ['paid', txHash, invoice.id, req.user.id]);

      await appendAuditLog(req.user.id, {
        action: 'settlement_auto',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        amount: invoice.grand_total,
        tx_hash: txHash,
        details: `Autonomous S2S capture successful. Razorpay Order ${order.id}, Payment ${txHash} verified as 'captured'.`
      });

      response = { success: true, message: 'Autonomously captured via S2S API', order_id: order.id, payment_id: txHash, invoice_uuid: invoice.id };
    } else {
      // No mandate token — agent escalates to a REAL Razorpay Payment Link
      txHash = order.id;
      await query('UPDATE invoices SET status = $1, tx_hash = $2 WHERE id = $3 AND user_id = $4', ['pending', txHash, invoice.id, req.user.id]);

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
      "UPDATE invoices SET status = 'pending', updated_date = NOW() WHERE id = $1 AND user_id = $2 AND status = 'processing'",
      [invoice.id, req.user.id]
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
  try {
    await query(
      "UPDATE users SET agent_delegation_max = $1, agent_daily_limit = COALESCE($2, agent_daily_limit) WHERE id = $3",
      [Number(maxAmount) || 0, dailyLimit != null ? Number(dailyLimit) : null, req.user.id]
    );
    await appendAuditLog(req.user.id, {
      action: 'delegation_updated',
      amount: Number(maxAmount) || 0,
      details: `Delegation cap updated to ₹${Number(maxAmount) || 0}${dailyLimit != null ? `, daily limit ₹${dailyLimit}` : ''}.`
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

app.post('/api/agent/verify', authMiddleware, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, invoice_id } = req.body;

  const isValid = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!isValid) {
    return res.status(400).json({ error: 'invalid_signature', message: 'Payment verification failed' });
  }

  const invoiceRes = await query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [invoice_id, req.user.id]);
  if (invoiceRes.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  const invoice = invoiceRes.rows[0];

  // ATOMIC CLAIM (TOCTOU guard): only mark paid if not already paid/processing.
  // Prevents concurrent verify calls from double-logging a settlement.
  const claim = await query(
    `UPDATE invoices SET status = 'paid', tx_hash = $1, payment_method = 'razorpay_agent', updated_date = NOW()
     WHERE id = $2 AND user_id = $3 AND status NOT IN ('paid', 'processing') RETURNING id`,
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

  res.json({ success: true, message: 'Payment verified successfully' });
});

// --- Campaigns ---
app.get('/api/campaigns', authMiddleware, async (req, res) => {
  const result = await query('SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_date DESC', [req.user.id]);
  res.json(result.rows);
});

app.post('/api/campaigns', authMiddleware, async (req, res) => {
  const { name, upsell_product_id, target_status, budget_cap } = req.body;
  const id = uuidv4();
  await query(
    'INSERT INTO campaigns (id, user_id, name, target_status, upsell_product_id, budget_cap) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, req.user.id, name, target_status || 'validated', upsell_product_id, budget_cap || 0]
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

  const statuses = campaign.target_status.split(',');
  const targetRes = await query('SELECT * FROM invoices WHERE user_id = $1 AND status = ANY($2) LIMIT 20', [req.user.id, statuses]);
  const targets = targetRes.rows;

  const productsRes = await query('SELECT * FROM products');
  const catalog = productsRes.rows;

  let created = 0;
  for (const inv of targets) {
    const productIds = campaign.upsell_product_id.split(',');
    const itemsToUpsell = productIds.map(id => catalog.find(p => p.id === id)).filter(Boolean);
    if (itemsToUpsell.length === 0) continue;
    
    // Create new invoice for the upsell
    const newId = uuidv4();
    const newInvNo = 'INV-' + Math.floor(Math.random() * 100000);
    
    let subtotal = 0;
    let tax_total = 0;
    const items = itemsToUpsell.map(item => {
      const amount = item.price;
      const taxRate = item.tax_rate || 18;
      const tax = Math.round(amount * (taxRate / 100));
      subtotal += amount;
      tax_total += tax;
      return { description: item.name, quantity: 1, unit_price: amount, tax_rate: taxRate, total: amount };
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

  await query("UPDATE campaigns SET status = 'launched', sent = $1 WHERE id = $2", [created, campaign.id]);
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

  const statuses = campaign.target_status.split(',');
  const targetRes = await query('SELECT * FROM invoices WHERE user_id = $1 AND status = ANY($2) LIMIT 3', [req.user.id, statuses]);
  res.json({ previews: targetRes.rows });
});

app.post('/api/webhooks/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return res.status(400).send('No signature');

  // Verify HMAC over the EXACT raw bytes Razorpay signed (not re-serialized JSON)
  const isValid = verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), signature);
  if (!isValid) return res.status(400).send('Invalid signature');

  // Always 200 quickly — Razorpay retries on non-2xx and we don't want storms
  const event = req.body.event;
  const payment = req.body.payload?.payment?.entity;
  const order = req.body.payload?.order?.entity;
  const receipt = payment?.notes?.receipt || order?.receipt;
  const orderId = payment?.order_id || order?.id;

  if (event === 'payment.captured' || event === 'order.paid') {
    // Locate the invoice by receipt (order creation path) OR by the order_id
    // we anchored into tx_hash during Payment-Link escalation (Unit 1 path)
    const invRes = await query(
      'SELECT id, user_id, invoice_number, grand_total, status, tx_hash FROM invoices WHERE invoice_number = $1 OR tx_hash = $2',
      [receipt, orderId]
    );
    const inv = invRes.rows[0];

    if (!inv) {
      console.warn(`[WEBHOOK] ${event}: no invoice matches receipt='${receipt}' order='${orderId}'`);
      return res.json({ status: 'ok', note: 'invoice_not_found' });
    }

    // AMOUNT GUARD: verify Razorpay's captured amount (paise) matches the invoice
    if (payment?.amount && Math.abs(payment.amount - Math.round(inv.grand_total * 100)) > 0) {
      await appendAuditLog(inv.user_id, {
        action: 'webhook_amount_mismatch',
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount: payment.amount / 100,
        details: `Webhook amount ${(payment.amount / 100).toFixed(2)} != invoice ${inv.grand_total.toFixed(2)}. Invoice NOT marked paid.`
      });
      return res.json({ status: 'ok', note: 'amount_mismatch' });
    }

    // IDEMPOTENCY: skip if already paid with the same payment id
    if (inv.status === 'paid' && inv.tx_hash === payment?.id) {
      return res.json({ status: 'ok', note: 'already_processed' });
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
    // Never silently drop failures — the audit ledger records them too
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
  // BUGFIX: Deterministic Compliance (Don't trust the LLM!)
  // Validate GSTIN format deterministically server-side
  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  let computedScore = data.compliance_score ?? data.score ?? 95;
  out.ai_suggestions = data.ai_suggestions || data.suggestions || data.issues || [];

  if (out.recipient_gst && !gstRegex.test(out.recipient_gst)) {
    computedScore = Math.min(computedScore, 65);
    out.ai_suggestions.push({
      field: "recipient_gst",
      issue: "CRITICAL: Invalid GSTIN Format detected by deterministic scan",
      suggestion: "The AI generated an invalid GST number. It must follow standard 15-char format (e.g. 07AAACN0372J1ZB).",
      severity: "critical"
    });
  }

  out.compliance_score = computedScore;
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
  const { name, description, price, margin_floor } = req.body;
  const id = crypto.randomUUID();
  try {
    await query(
      'INSERT INTO products (id, user_id, name, description, price, margin_floor) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.user.id, name, description, Number(price), Number(margin_floor)]
    );
    res.json({ success: true, id });
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
    const sessions = await query("SELECT id, buyer_name, updated_at AT TIME ZONE 'UTC' as updated_at, jsonb_array_length(messages) as message_count FROM chat_sessions ORDER BY updated_at DESC");
    res.json(sessions.rows);
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.get('/api/chat/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const sessions = await query('SELECT * FROM chat_sessions WHERE id = $1', [req.params.id]);
    res.json(sessions.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.delete('/api/chat/sessions/:id', authMiddleware, async (req, res) => {
  try {
    await query('DELETE FROM chat_sessions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'transcript_error', message: err.message });
  }
});

app.post('/api/chat/sync', async (req, res) => {
  // Syncing chat is usually unauthenticated for the buyer (since they use the chat portal)
  // For the demo we tie it to a static session ID or create one
  const { session_id, messages, buyer_name } = req.body;
  try {
    const existing = await query('SELECT id FROM chat_sessions WHERE id = $1', [session_id]);
    if (existing.rows.length > 0) {
      await query('UPDATE chat_sessions SET messages = $1, buyer_name = $2, updated_at = NOW() WHERE id = $3', [JSON.stringify(messages), buyer_name, session_id]);
    } else {
      // Default to the first merchant user ID for demo purposes
      const userRes = await query('SELECT id FROM users LIMIT 1');
      const userId = userRes.rows[0]?.id || 'demo-user';
      await query('INSERT INTO chat_sessions (id, user_id, buyer_name, messages) VALUES ($1, $2, $3, $4)', [session_id, userId, buyer_name, JSON.stringify(messages)]);
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
                  description: { type: "string", description: "Name of the product/service" },
                  amount: { type: "number", description: "Unit price of the product/service" },
                  quantity: { type: "number", description: "Quantity of this item" }
                },
                required: ["description", "amount", "quantity"]
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
                  description: { type: "string" },
                  amount: { type: "number" },
                  quantity: { type: "number" }
                },
                required: ["description", "amount", "quantity"]
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
    const productsRes = await query('SELECT name, description, price, margin_floor FROM products');
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
    const timeout = setTimeout(() => controller.abort(), 12000);

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

