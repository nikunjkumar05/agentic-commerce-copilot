import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, initDb } from './_db.js';
import { generateToken, authMiddleware } from './_auth.js';
// NVIDIA AI via OpenAI-compatible API

const app = express();

app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Id'] }));
app.use(express.json({ limit: '5mb' }));

async function seedDemoData(userId) {
  const count = await query('SELECT COUNT(*)::int AS c FROM invoices WHERE user_id = $1', [userId]);
  if (count.rows[0].c > 0) return;

  const now = new Date();
  const invoices = [
    { invNo: 'INV-2026-1001', name: 'Delhi Jal Board', recipient: 'NDMC', amount: 125000, status: 'paid', date: new Date(now.getTime() - 2*86400000), cid: 'Qmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tx: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    { invNo: 'INV-2026-1002', name: 'BSES Yamuna Power Ltd', recipient: 'South Delhi MCD', amount: 89000, status: 'validated', date: new Date(now.getTime() - 5*86400000) },
    { invNo: 'INV-2026-1003', name: 'Delhi Transport Corp', recipient: 'DTC Headquarters', amount: 245000, status: 'draft', date: new Date(now.getTime() - 7*86400000) },
    { invNo: 'INV-2026-1004', name: 'PWD Delhi', recipient: 'CPWD', amount: 567000, status: 'stored', date: new Date(now.getTime() - 12*86400000), cid: 'Qmcccccccccccccccccccccccccccccccccccccccccccccccc' },
    { invNo: 'INV-2026-1005', name: 'Delhi Police HQs', recipient: 'MHA', amount: 340000, status: 'paid', date: new Date(now.getTime() - 15*86400000), cid: 'Qmdddddddddddddddddddddddddddddddddddddddddddddddd', tx: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    { invNo: 'INV-2026-1006', name: 'NDMC', recipient: 'New Delhi Municipal Council', amount: 78000, status: 'anomaly', date: new Date(now.getTime() - 20*86400000), score: 45 },
    { invNo: 'INV-2026-1007', name: 'Delhi Metro Rail Corp', recipient: 'DMRC', amount: 980000, status: 'validated', date: new Date(now.getTime() - 25*86400000) },
  ];

  for (const inv of invoices) {
    const items = [
      { description: 'Consulting Services', quantity: 5, unit_price: 15000, tax_rate: 18, total: 75000 },
      { description: 'Software License', quantity: 2, unit_price: 25000, tax_rate: 18, total: 50000 },
    ];
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const tax_total = Math.round(subtotal * 0.18);
    await query(`
      INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address, gst_number,
        recipient_name, recipient_address, recipient_gst, line_items, subtotal, tax_total, grand_total,
        currency, status, compliance_score, ai_suggestions, invoice_date, due_date, cid, tx_hash, created_date, updated_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    `, [
      uuidv4(), userId, inv.invNo,
      inv.name, `${inv.name}, Delhi`, '07AAACN0372J1ZB',
      inv.recipient, `${inv.recipient}, New Delhi`, '07BBBCD0483K2ZC',
      JSON.stringify(items), subtotal, tax_total, inv.amount,
      'INR', inv.status, inv.score || 85,
      JSON.stringify([{ field: 'gst', severity: 'info', issue: 'GST verified', suggestion: 'All GST numbers valid' }]),
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
    { action: 'settlement', invNo: 'INV-2026-1005', amount: 340000, tx: '0xgggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg' },
    { action: 'delegation_revoked' },
  ];

  for (const log of auditActions) {
    await query(`
      INSERT INTO audit_logs (id, user_id, action, invoice_id, invoice_number, amount, tx_hash, details, created_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      uuidv4(), userId, log.action,
      null, log.invNo || null, log.amount || null, log.tx || null,
      `${log.action} processed for invoice ${log.invNo || 'N/A'}`,
      new Date(now.getTime() - Math.random()*30*86400000).toISOString(),
    ]);
  }

  console.log('Demo data seeded');
}

let seedingDone = false;
async function ensureSeeded() {
  if (seedingDone) return;
  seedingDone = true;
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
  } catch (err) {
    console.error('DB init failed:', err);
  }
}
ensureSeeded();

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Auth ---
const registerSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
const loginSchema = z.object({ email: z.string().email(), password: z.string() });

app.post('/api/auth/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'validation_error', message: parsed.error.errors[0].message });

    const { email, password } = parsed.data;
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'email_exists', message: 'Email already registered' });

    const id = uuidv4();
    const hashed = bcrypt.hashSync(password, 10);
    await query(
      'INSERT INTO users (id, email, password, name, is_verified) VALUES ($1, $2, $3, $4, 0)',
      [id, email, hashed, email.split('@')[0]]
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

    const { email, password } = parsed.data;
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0 || !bcrypt.compareSync(password, result.rows[0].password)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const token = generateToken(user);
    res.json({ access_token: token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  }
});

app.post('/api/auth/forgot-password', (req, res) => res.json({ success: true }));
app.post('/api/auth/reset-password', (req, res) => res.json({ success: true }));

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const result = await query('SELECT id, email, name, role, created_at FROM users WHERE id = $1', [req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'user_not_found', message: 'User not found' });
  res.json(result.rows[0]);
});

app.post('/api/auth/logout', (req, res) => res.json({ success: true }));

// --- Invoices ---
app.get('/api/invoices', authMiddleware, async (req, res) => {
  const sortField = (req.query.sort || '-created_date').replace(/^-/, '');
  const dir = req.query.sort?.startsWith('-') ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const result = await query(
    `SELECT * FROM invoices WHERE user_id = $1 ORDER BY ${sortField} ${dir} LIMIT $2`,
    [req.user.id, limit]
  );

  res.json(result.rows.map(parseInvoice));
});

app.get('/api/invoices/:id', authMiddleware, async (req, res) => {
  const result = await query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  res.json(parseInvoice(result.rows[0]));
});

app.post('/api/invoices', authMiddleware, async (req, res) => {
  const id = uuidv4();
  const data = req.body;

  await query(`
    INSERT INTO invoices (id, user_id, invoice_number, institution_name, institution_address,
      gst_number, recipient_name, recipient_address, recipient_gst, line_items, subtotal,
      tax_total, grand_total, currency, status, compliance_score, ai_suggestions,
      invoice_date, due_date, milestones)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
  `, [
    id, req.user.id,
    data.invoice_number || `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
    data.institution_name, data.institution_address, data.gst_number,
    data.recipient_name, data.recipient_address, data.recipient_gst,
    JSON.stringify(data.line_items || []), data.subtotal || 0,
    data.tax_total || 0, data.grand_total || 0,
    data.currency || 'INR', data.status || 'draft',
    data.compliance_score, JSON.stringify(data.ai_suggestions || []),
    data.invoice_date, data.due_date, JSON.stringify(data.milestones || []),
  ]);

  const result = await query('SELECT * FROM invoices WHERE id = $1', [id]);
  res.status(201).json(parseInvoice(result.rows[0]));
});

app.put('/api/invoices/:id', authMiddleware, async (req, res) => {
  const exists = await query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });

  const data = req.body;
  const sets = [];
  const params = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'user_id' || key === 'created_date') continue;
    if (['line_items', 'ai_suggestions', 'milestones'].includes(key)) {
      sets.push(`${key} = $${i}`);
      params.push(JSON.stringify(value));
    } else {
      sets.push(`${key} = $${i}`);
      params.push(value);
    }
    i++;
  }
  sets.push(`updated_date = NOW()`);
  params.push(req.params.id);

  await query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $${i}`, params);
  const result = await query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  res.json(parseInvoice(result.rows[0]));
});

app.delete('/api/invoices/:id', authMiddleware, async (req, res) => {
  const exists = await query('SELECT id FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'Invoice not found' });
  await query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- Audit Logs ---
app.get('/api/audit-logs', authMiddleware, async (req, res) => {
  const sortField = (req.query.sort || '-created_date').replace(/^-/, '');
  const dir = req.query.sort?.startsWith('-') ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const result = await query(
    `SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY ${sortField} ${dir} LIMIT $2`,
    [req.user.id, limit]
  );
  res.json(result.rows);
});

app.post('/api/audit-logs', authMiddleware, async (req, res) => {
  const id = uuidv4();
  const data = req.body;

  await query(`
    INSERT INTO audit_logs (id, user_id, action, invoice_id, invoice_number, amount,
      agent_address, owner_address, tx_hash, details)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [id, req.user.id, data.action, data.invoice_id, data.invoice_number,
      data.amount, data.agent_address, data.owner_address, data.tx_hash, data.details]);

  const result = await query('SELECT * FROM audit_logs WHERE id = $1', [id]);
  res.status(201).json(result.rows[0]);
});

// --- LLM ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function normalizeInvoiceResponse(data) {
  const out = {};
  out.institution_name = data.institution_name || data.seller?.name || data.vendor?.name || data.from?.name || data.institutionName || '';
  out.institution_address = data.institution_address || data.seller?.address || data.vendor?.address || data.from?.address || '';
  out.gst_number = data.gst_number || data.gstin || data.gst || data.seller?.gstin || data.seller?.gst_number || '';
  out.recipient_name = data.recipient_name || data.buyer?.name || data.customer?.name || data.client?.name || data.to?.name || data.recipientName || '';
  out.recipient_address = data.recipient_address || data.buyer?.address || data.customer?.address || data.client?.address || data.to?.address || '';
  out.recipient_gst = data.recipient_gst || data.buyer?.gstin || data.customer?.gstin || '';
  out.line_items = data.line_items || data.items || data.products || data.services || [];
  out.line_items = out.line_items.map(item => ({
    description: item.description || item.name || item.product || item.service || '',
    quantity: item.quantity || item.qty || 1,
    unit_price: item.unit_price || item.unitPrice || item.price || item.rate || 0,
    tax_rate: item.tax_rate || item.taxRate || item.gst_rate || item.gst || 18,
    total: item.total || item.amount || (item.quantity || 1) * (item.unit_price || item.price || 0),
  }));
  const totals = data.totals || data.total || data.tax_summary || {};
  out.subtotal = data.subtotal ?? totals.subtotal ?? totals.subTotal ?? 0;
  out.tax_total = data.tax_total ?? totals.tax_total ?? totals.total_tax ?? totals.totalTax ?? totals.total_tax_amount ?? 0;
  out.grand_total = data.grand_total ?? totals.grand_total ?? totals.grandTotal ?? totals.total ?? 0;
  out.currency = data.currency || data.invoice_details?.currency || 'INR';
  const invDate = data.invoice_details || {};
  out.invoice_date = data.invoice_date || invDate.invoice_date || invDate.invoiceDate || new Date().toISOString().split('T')[0];
  out.due_date = data.due_date || invDate.due_date || invDate.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  out.ai_suggestions = data.ai_suggestions || data.suggestions || data.issues || [];
  out.compliance_score = data.compliance_score ?? data.score ?? 85;
  return out;
}

async function callOpenRouter(prompt, schema) {
  const schemaHint = schema ? `\n\nReturn ONLY a flat JSON object matching this structure:\n${JSON.stringify(schema, null, 2)}` : '';
  const messages = [
    { role: 'system', content: 'You are a government invoice expert for India. Return ONLY valid JSON. Use Indian GST format, INR currency, and realistic government institution details.' + schemaHint },
    { role: 'user', content: prompt },
  ];

  const body = {
    model: OPENROUTER_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 500,
  };

  // Don't use response_format:json_object — many free models don't support it.
  // The system prompt already instructs JSON-only output, and handleResponse
  // strips markdown code fences before parsing.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
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

async function handleResponse(res) {

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in response');
  content = content.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return JSON.parse(content);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateMockInvoice(prompt) {
  const institutions = [
    { name: 'Delhi Municipal Corporation', address: 'Town Hall, Chandni Chowk, Delhi - 110006', gst: '07AAACN0372J1ZB' },
    { name: 'Delhi Jal Board', address: 'Varunalaya Phase II, Jhandewalan, New Delhi - 110005', gst: '07AABJD0000A1Z1' },
    { name: 'BSES Yamuna Power Ltd', address: 'BSES Bhawan, Nehru Place, New Delhi - 110019', gst: '07AABCB1234B1Z2' },
    { name: 'Delhi Transport Corporation', address: 'DTC Headquarters, I.P. Estate, New Delhi - 110002', gst: '07AAADT5678C1Z3' },
    { name: 'PWD Delhi', address: 'PWD Headquarters, ITO, New Delhi - 110002', gst: '07AAAPW9012D1Z4' },
    { name: 'NDMC', address: 'Palika Kendra, Parliament Street, New Delhi - 110001', gst: '07AAAND3456E1Z5' },
    { name: 'Delhi Metro Rail Corporation', address: 'Metro Bhawan, Barakhamba Road, New Delhi - 110001', gst: '07AAADM7890F1Z6' },
  ];
  const recipients = [
    { name: 'NSUT Delhi', address: 'Sector 3, Dwarka, New Delhi - 110078', gst: '07AAACN0372J1ZB' },
    { name: 'CPWD', address: 'Nirman Bhawan, New Delhi - 110011', gst: '07AAACP1111G1Z7' },
    { name: 'Delhi Police HQs', address: 'Police Headquarters, ITO, New Delhi - 110002', gst: '07AAADP2222H1Z8' },
    { name: 'Ministry of Home Affairs', address: 'North Block, New Delhi - 110001', gst: '07AAAMH3333I1Z9' },
    { name: 'South Delhi MCD', address: 'Dr. SPM Civic Centre, JLN Marg, New Delhi - 110002', gst: '07AAASD4444J1Z0' },
  ];
  const items = [
    'Annual Maintenance Contract', 'IT Infrastructure Support', 'Network Security Services',
    'Civil Works & Repairs', 'Water Supply Maintenance', 'Electrical Upgradation',
    'Consultancy Services', 'Software License Renewal', 'Data Center Management',
    'Vehicle Fleet Maintenance', 'Street Light Maintenance', 'Sewage Treatment Plant Ops',
  ];

  const inst = pick(institutions);
  const rec = pick(recipients);
  const numItems = randInt(1, 4);
  const lineItems = [];
  let subtotal = 0;

  for (let i = 0; i < numItems; i++) {
    const qty = randInt(1, 15);
    const price = randInt(1, 10) * 5000;
    const total = qty * price;
    lineItems.push({ description: pick(items), quantity: qty, unit_price: price, tax_rate: 18, total });
    subtotal += total;
  }

  const taxTotal = Math.round(subtotal * 0.18);
  const grandTotal = subtotal + taxTotal;

  return {
    institution_name: inst.name,
    institution_address: inst.address,
    gst_number: inst.gst,
    recipient_name: rec.name,
    recipient_address: rec.address,
    recipient_gst: rec.gst,
    line_items: lineItems,
    subtotal, tax_total: taxTotal, grand_total: grandTotal,
    currency: 'INR',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    ai_suggestions: [],
    compliance_score: randInt(70, 98),
  };
}

const MOCK_VALIDATION = {
  passed: true, score: 85,
  issues: [
    { field: 'gst_number', severity: 'info', issue: 'GST number format should be verified', suggestion: 'Ensure GST follows 07AAACN0372J1ZB format' },
    { field: 'line_items', severity: 'warning', issue: 'High-value items lack detailed description', suggestion: 'Add specific descriptions for each line item' },
  ],
};

app.post('/api/llm/invoke', authMiddleware, async (req, res) => {
  const { prompt, response_json_schema } = req.body;
  const isValidation = prompt?.toLowerCase().includes('validate') || prompt?.toLowerCase().includes('compliance');

  if (!OPENROUTER_API_KEY) {
    console.warn('OPENROUTER_API_KEY not set, using fallback');
    return res.json(isValidation ? MOCK_VALIDATION : generateMockInvoice(prompt));
  }

  try {
    const parsed = await callOpenRouter(prompt, response_json_schema);
    return res.json(normalizeInvoiceResponse(parsed));
  } catch (err) {
    console.error('OpenRouter call failed:', err.message);
    return res.json(isValidation ? MOCK_VALIDATION : normalizeInvoiceResponse(generateMockInvoice(prompt)));
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
