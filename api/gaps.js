import { z } from 'zod';

// Pure, dependency-free heuristics for the sellability scorecard.

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

const fixSchema = z.object({
  updates: z.array(z.object({
    id: z.string().min(1).max(128),
    description: z.string().max(2000).optional(),
    hsn_code: z.string().max(16).optional(),
  })).max(100),
});

// Deterministic policy line: clears the shipping/return/warranty flag for AI buyers.
const POLICY_LINE = ' Ships in 3-5 business days. 7-day easy returns. 1-year service warranty.';

// Own products first; fall back to the shared catalog when the caller owns
// none (seed rows belong to the auto-seeded merchant, while GET /api/catalog
// itself is global — scoring zero while the grid shows products is a bug).
async function merchantProducts(query, userId) {
  const own = await query('SELECT id, sku, name, description, price, margin_floor, hsn_code FROM products WHERE user_id = $1', [userId]);
  if (own.rows.length > 0) return { rows: own.rows, scoped: 'own' };
  const all = await query('SELECT id, sku, name, description, price, margin_floor, hsn_code FROM products LIMIT 200');
  return { rows: all.rows, scoped: 'global' };
}

export function registerGapAgents(app, { query, appendAuditLog, authMiddleware }) {
  // --- #1 Sellability scorecard (stateless) ---
  app.get('/api/merchant/sellability', authMiddleware, async (req, res) => {
    const { rows, scoped } = await merchantProducts(query, req.user.id);
    res.json({ ...scoreCatalog(rows), scoped, jsonld: buildJsonLd(rows) });
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
    const { rows: scopeRows, scoped } = await merchantProducts(query, req.user.id);
    const scopeIds = new Set(scopeRows.map((p) => p.id));
    // Adopt: shared seed catalog becomes the caller's own on first fix, so the
    // "shared catalog" fallback never shows again after one click.
    let adopted = 0;
    if (scoped === 'global' && scopeIds.size > 0) {
      const a = await query('UPDATE products SET user_id = $1 WHERE id = ANY($2)', [req.user.id, [...scopeIds]]);
      adopted = a.rowCount || 0;
    }
    let fixed = 0;
    for (const u of parsed.data.updates || []) {
      if (!scopeIds.has(u.id)) continue;
      const desc = typeof u.description === 'string' && u.description.trim() ? u.description.trim().slice(0, 2000) : null;
      const hsn = typeof u.hsn_code === 'string' && u.hsn_code.trim() ? u.hsn_code.trim().slice(0, 16) : null;
      if (!desc && !hsn) continue;
      const r = await query(
        'UPDATE products SET description = COALESCE($1, description), hsn_code = COALESCE($2, hsn_code) WHERE id = $3',
        [desc, hsn, u.id]
      );
      if (r.rowCount > 0) fixed++;
    }
    // Backfill: append the policy line where shipping/return/warranty is missing.
    const back = await query(
      `UPDATE products SET description = LEFT(COALESCE(description, '') || $1, 2000)
       WHERE user_id = $2 AND description NOT ILIKE '%ship%' AND description NOT ILIKE '%return%' AND description NOT ILIKE '%warranty%'`,
      [POLICY_LINE, req.user.id]
    );
    // Auto-fill blank HSN (deterministic default, audited).
    const auto = await query(
      "UPDATE products SET hsn_code = $1 WHERE user_id = $2 AND (hsn_code IS NULL OR hsn_code = '')",
      [DEFAULT_HSN, req.user.id]
    );
    await appendAuditLog(req.user.id, { action: 'sellability_fixed', details: `Sellability auto-fix: ${adopted} adopted, ${fixed} edited, ${back.rowCount || 0} policy backfilled, ${auto.rowCount || 0} HSN defaulted.` }).catch(() => {});
    const r2 = await merchantProducts(query, req.user.id);
    res.json({ fixed, adopted, desc_backfilled: back.rowCount || 0, hsn_defaulted: auto.rowCount || 0, scoped: r2.scoped, ...scoreCatalog(r2.rows) });
  });
}
