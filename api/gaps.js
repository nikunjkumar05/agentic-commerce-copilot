import crypto from 'crypto';
import { z } from 'zod';

// Pure, dependency-free heuristics for #1 (sellability) + #5 (liability).
// No new tables except liability_chain (lazy CREATE IF NOT EXISTS).

const HAS_DEVANAGARI = /[\u0900-\u097F]/;
const HAS_LATIN = /[A-Za-z]/;
const DEFAULT_HSN = '998313';

export function scoreProduct(p) {
  const fixes = [];
  let points = 0;
  const name = String(p?.name || '');
  const desc = String(p?.description || '');
  const price = Number(p?.price);
  const floor = Number(p?.margin_floor);

  // 20: name clean + single script (Hindi+English mix confuses AI buyers)
  if (name.length >= 3 && !(HAS_DEVANAGARI.test(name) && HAS_LATIN.test(name))) points += 20;
  else fixes.push('Standardize product name to a single script (Hindi+English mix is unparseable).');

  // 20: description AI-readable (>=20 chars, mentions shipping/return)
  if (desc.length >= 20) points += 10;
  else fixes.push('Add a >=20-char description; AI buyer skips blank/short ones.');
  if (/ship|return|warranty|delivery/i.test(desc)) points += 10;
  else fixes.push('Mention shipping/return/warranty in description or AI buyer skips you.');

  // 20: price + margin_floor sane
  if (Number.isFinite(price) && price > 0 && price <= 99999999.99
    && Number.isFinite(floor) && floor >= 0 && floor <= price) points += 20;
  else fixes.push('Fix price/margin_floor: need 0 <= floor <= price.');

  // 20: sku + hsn present
  if (p?.sku) points += 10;
  else fixes.push('Add SKU; quotable products require one.');
  if (p?.hsn_code) points += 10;
  else fixes.push(`Add HSN code (default ${DEFAULT_HSN}).`);

  // 20: machine tags / category signal
  if (desc.length >= 20 && Number.isFinite(price) && price > 0) points += 20;
  else fixes.push('Missing machine-readable price+description pair.');

  return { score: points, fixes };
}

export function scoreCatalog(products) {
  const rows = Array.isArray(products) ? products : [];
  if (rows.length === 0) return { score: 0, product_count: 0, issues: [], questions: ['Catalog is empty. Add products via Merchant Portal.'] };
  const issues = [];
  let total = 0;
  for (const p of rows) {
    const { score, fixes } = scoreProduct(p);
    total += score;
    if (fixes.length) issues.push({ product_id: p.id || null, sku: p.sku || null, name: p.name || null, fixes });
  }
  const questions = [];
  if (issues.some((i) => i.fixes.some((f) => f.includes('HSN')))) questions.push('What HSN code applies to products missing one? (suggested 998313 for SaaS)');
  if (issues.some((i) => i.fixes.some((f) => f.includes('shipping')))) questions.push('What is your standard shipping time + return window? (e.g. 3-5 days, 7-day returns)');
  return { score: Math.round(total / rows.length), product_count: rows.length, issues, questions };
}

export function buildJsonLd(products, merchant = {}) {
  const rows = Array.isArray(products) ? products : [];
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: merchant.name || 'Merchant catalog',
    itemListElement: rows.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        sku: p.sku || p.id,
        name: p.name,
        description: p.description || undefined,
        category: p.hsn_code ? `HSN:${p.hsn_code}` : undefined,
        offers: {
          '@type': 'Offer',
          priceCurrency: 'INR',
          price: Number(p.price),
          availability: 'https://schema.org/InStock',
        },
      },
    })),
  };
}

const LIABLE_PARTIES = ['buyer_agent', 'seller_agent', 'merchant', 'platform', 'none'];

// Heuristic auto-suggest (server never trusts client label blindly for display).
export function suggestLiableParty({ instruction, interpretation, action_taken }) {
  const a = String(instruction || '').toLowerCase();
  const b = String(interpretation || '').toLowerCase();
  const c = String(action_taken || '').toLowerCase();
  if (!a || !b) return 'none';
  if (b !== a && !b.includes(a.slice(0, 12)) && a.length > 4) return 'seller_agent'; // misinterpretation
  if (c.includes('blocked') || c.includes('escalat')) return 'none'; // gate worked
  if (a === b && c.includes(b.slice(0, 10))) return 'merchant'; // catalog/policy ambiguity, executed as written
  return 'none';
}

const fixSchema = z.object({
  updates: z.array(z.object({
    id: z.string().min(1).max(128),
    description: z.string().max(2000).optional(),
    hsn_code: z.string().max(16).optional(),
  })).min(1).max(100),
});

const liabilitySchema = z.object({
  invoice_id: z.string().min(1).max(128),
  instruction: z.string().min(1).max(2000),
  interpretation: z.string().min(1).max(2000),
  action_taken: z.string().min(1).max(2000),
  deviation: z.string().max(2000).optional().default(''),
  liable_party: z.enum(LIABLE_PARTIES),
});

async function ensureLiabilityTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS liability_chain (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      interpretation TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      deviation TEXT DEFAULT '',
      liable_party TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_liability_invoice ON liability_chain (invoice_id);
  `);
}

export function registerGapAgents(app, { query, appendAuditLog, authMiddleware }) {
  ensureLiabilityTable(query).catch(() => {});

  // --- #1 Sellability scorecard (merchant-scoped, stateless) ---
  app.get('/api/merchant/sellability', authMiddleware, async (req, res) => {
    const r = await query('SELECT id, sku, name, description, price, margin_floor, hsn_code FROM products WHERE user_id = $1', [req.user.id]);
    const result = scoreCatalog(r.rows);
    res.json({ ...result, jsonld: buildJsonLd(r.rows) });
  });

  app.get('/api/merchant/sellability/jsonld', async (req, res) => {
    // Public: AI buyers fetch this without auth (same posture as GET /api/catalog).
    const r = await query('SELECT sku, id, name, description, price, hsn_code FROM products LIMIT 200');
    res.setHeader('Content-Type', 'application/ld+json');
    res.json(buildJsonLd(r.rows));
  });

  app.post('/api/merchant/sellability/fix', authMiddleware, async (req, res) => {
    const parsed = fixSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_fix', message: parsed.error.issues[0]?.message || 'Invalid fix payload.' });
    let fixed = 0;
    for (const u of parsed.data.updates) {
      const desc = typeof u.description === 'string' && u.description.trim() ? u.description.trim().slice(0, 2000) : null;
      const hsn = typeof u.hsn_code === 'string' && u.hsn_code.trim() ? u.hsn_code.trim().slice(0, 16) : null;
      if (!desc && !hsn) continue;
      const r = await query(
        'UPDATE products SET description = COALESCE($1, description), hsn_code = COALESCE($2, hsn_code) WHERE id = $3 AND user_id = $4',
        [desc, hsn, u.id, req.user.id]
      );
      if (r.rowCount > 0) fixed++;
    }
    // Auto-fill blank HSN for own catalog (deterministic default, audited).
    const auto = await query(
      "UPDATE products SET hsn_code = $1 WHERE user_id = $2 AND (hsn_code IS NULL OR hsn_code = '')",
      [DEFAULT_HSN, req.user.id]
    );
    await appendAuditLog(req.user.id, { action: 'sellability_fixed', details: `Sellability auto-fix: ${fixed} edited, ${auto.rowCount || 0} HSN defaulted.` }).catch(() => {});
    const r2 = await query('SELECT id, sku, name, description, price, margin_floor, hsn_code FROM products WHERE user_id = $1', [req.user.id]);
    res.json({ fixed, hsn_defaulted: auto.rowCount || 0, ...scoreCatalog(r2.rows) });
  });

  // --- #5 Liability chain (evidence for disputes) ---
  app.post('/api/audit/liability', authMiddleware, async (req, res) => {
    const parsed = liabilitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_liability', message: parsed.error.issues[0]?.message || 'Invalid liability payload.' });
    await ensureLiabilityTable(query);
    const inv = await query('SELECT id FROM invoices WHERE id = $1', [parsed.data.invoice_id]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'invoice_not_found', message: 'Invoice not found.' });
    const id = crypto.randomUUID();
    await query(
      'INSERT INTO liability_chain (id, invoice_id, user_id, instruction, interpretation, action_taken, deviation, liable_party) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, parsed.data.invoice_id, req.user.id, parsed.data.instruction, parsed.data.interpretation, parsed.data.action_taken, parsed.data.deviation || '', parsed.data.liable_party]
    );
    await appendAuditLog(req.user.id, {
      action: 'liability_recorded', invoice_id: parsed.data.invoice_id,
      details: `Liability: ${parsed.data.liable_party} | instruction "${parsed.data.instruction.slice(0, 80)}"`,
    }).catch(() => {});
    res.status(201).json({ id, suggested_party: suggestLiableParty(parsed.data) });
  });

  app.get('/api/audit/liability/:invoiceId', authMiddleware, async (req, res) => {
    await ensureLiabilityTable(query);
    const invoiceId = String(req.params.invoiceId || '').slice(0, 128);
    const inv = await query('SELECT id, user_id FROM invoices WHERE id = $1', [invoiceId]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'invoice_not_found', message: 'Invoice not found.' });
    const chain = await query('SELECT * FROM liability_chain WHERE invoice_id = $1 ORDER BY created_at ASC', [invoiceId]);
    const mine = chain.rows.filter((e) => e.user_id === req.user.id);
    if (inv.rows[0].user_id !== req.user.id && mine.length === 0) {
      return res.status(403).json({ error: 'forbidden', message: 'Not your invoice or report.' });
    }
    const byParty = {};
    for (const e of chain.rows) byParty[e.liable_party] = (byParty[e.liable_party] || 0) + 1;
    const ledger = await query('SELECT action, details, created_date FROM audit_logs WHERE invoice_id = $1 AND user_id = $2 ORDER BY created_date ASC LIMIT 100', [invoiceId, req.user.id]);
    res.json({
      invoice_id: invoiceId,
      entries: chain.rows,
      summary: { total: chain.rows.length, by_party: byParty },
      evidence: ledger.rows,
    });
  });
}
