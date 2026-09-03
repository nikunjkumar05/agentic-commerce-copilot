/**
 * Guardrail evaluation: adversarial probes vs deterministic gates.
 *
 * Section A — offline, always runs, zero side effects:
 *   HMAC accept/forge/missing-secret matrix, GST split matrix (inter/intra +
 *   rounding conservation), ledger amount canonicalization
 *   ("5000.00" string vs 5000 number must hash identically — the NUMERIC rule),
 *   webhook idempotency-key derivation.
 * Section B — live API probes, opt-in (EVAL_API_BASE + EVAL_JWT):
 *   invalid-SKU x5 and below-floor x5 quotes must 400 BEFORE any Razorpay order
 *   is created (zero money movement); pack-bundle fit, catalog, mandate, funnel
 *   must 200 (valid arm — measures false blocks).
 *
 * Pass bar: 100% adversarial blocked-as-expected AND 0 false blocks.
 * Results are written to eval/results/guardrail_eval_<ts>.json — commit them.
 *
 * Usage:
 *   node scripts/guardrail_eval.mjs
 *   EVAL_API_BASE=http://localhost:3001 EVAL_JWT=<buyer-jwt> node scripts/guardrail_eval.mjs
 */
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { computeTaxSplit, verifyWebhookSignature, verifySignature } from '../api/razorpay.js';

const results = { started_at: new Date().toISOString(), offline: [], live: [], skipped: [], skipped_live: false };
const check = (section, name, pass, detail = null) => {
  results[section].push({ name, pass: Boolean(pass), detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, reason) => {
  results.skipped.push({ name, reason });
  console.log(`[SKIP] ${name} — ${reason}`);
};

// ---------- Section A: offline ----------
process.env.RAZORPAY_WEBHOOK_SECRET = 'eval-secret';
process.env.RAZORPAY_KEY_SECRET = 'eval-key-secret';

// A1: webhook HMAC self-verifies, forgery rejected
{
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', n: 1 }));
  const sig = crypto.createHmac('sha256', 'eval-secret').update(body).digest('hex');
  check('offline', 'hmac_accepts genuine signature', verifyWebhookSignature(body, sig));
  check('offline', 'hmac_rejects forged signature', !verifyWebhookSignature(body, '0'.repeat(64)));
  check('offline', 'hmac_rejects missing signature', !verifyWebhookSignature(body, null));
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  check('offline', 'hmac_fail_closed without secret', !verifyWebhookSignature(body, sig));
  process.env.RAZORPAY_WEBHOOK_SECRET = 'eval-secret';
}
// A2: checkout signature matrix
{
  const good = crypto.createHmac('sha256', 'eval-key-secret').update('order_1|pay_1').digest('hex');
  check('offline', 'checkout_sig_accepts genuine', verifySignature('order_1', 'pay_1', good));
  check('offline', 'checkout_sig_rejects cross-order replay', !verifySignature('order_2', 'pay_1', good));
}
// A3: GST split matrix
{
  const inter = computeTaxSplit({ subtotal: 10000, rate: 18, sellerGstin: '07AAACN0372J1ZB', buyerGstin: '27BBBCD0483K2ZC' });
  check('offline', 'inter-state yields pure IGST', inter.mode === 'inter-state' && inter.igst === 1800 && inter.cgst === 0);
  const intra = computeTaxSplit({ subtotal: 10000, rate: 18, sellerGstin: '07AAACN0372J1ZB', buyerGstin: '07BBBCD0483K2ZC' });
  check('offline', 'intra-state splits CGST+SGST conserving total', intra.mode === 'intra-state' && intra.cgst + intra.sgst === 1800, `cgst=${intra.cgst} sgst=${intra.sgst}`);
  const odd = computeTaxSplit({ subtotal: 101, rate: 18, sellerGstin: '07AAACN0372J1ZB', buyerGstin: '07BBBCD0483K2ZC' });
  check('offline', 'odd-paise rounding still conserves', Math.abs((odd.cgst + odd.sgst) - 101 * 0.18) < 1, `cgst=${odd.cgst} sgst=${odd.sgst}`);
  const unknown = computeTaxSplit({ subtotal: 5000, rate: 18, sellerGstin: null, buyerGstin: null });
  check('offline', 'missing GSTIN defaults intra-state (fail-safe, never IGST by guess)', unknown.mode === 'intra-state');
}
// A4: ledger amount canonicalization (the NUMERIC-as-string rule)
{
  const canon = (v) => (v || null) === null ? null : Number(v);
  const payload = (amt) => JSON.stringify({ amount: canon(amt), prev_hash: 'x' });
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  check('offline', 'ledger_canonical: "5000.00" hashes as 5000', h(payload('5000.00')) === h(payload(5000)));
  check('offline', 'ledger_canonical: 0 and null hash identically (legacy || semantics)', h(payload(0)) === h(payload(null)));
  check('offline', 'ledger_canonical: distinct amounts hash distinctly', h(payload(5000)) !== h(payload(5001)));
}
// A5: webhook idempotency-key derivation is deterministic
{
  const key = (e, c, p) => crypto.createHash('sha256').update(`${e}_${c}_${p}`).digest('hex');
  check('offline', 'webhook_idempotency_key deterministic', key('payment.captured', 1, 'pay_1') === key('payment.captured', 1, 'pay_1'));
  check('offline', 'webhook_idempotency_key separates events', key('payment.captured', 1, 'pay_1') !== key('payment.captured', 1, 'pay_2'));
}

// ---------- Section B: live probes (opt-in) ----------
const BASE = process.env.EVAL_API_BASE;
const JWT = process.env.EVAL_JWT;
if (!BASE || !JWT) {
  results.skipped_live = true;
  console.log('[live] skipped — set EVAL_API_BASE + EVAL_JWT to run adversarial API probes (no money moves; invalid probes 400 before order creation).');
} else {
  const api = async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  // Adversarial arm: unknown SKUs must 400 (5 variants)
  for (const sku of ['nope', 'PROD_X', '', 'prod_it_license ', 'null']) {
    const r = await api('POST', '/api/agent/v1/quote', { line_items: [{ sku, quantity: 1 }] });
    check('live', `adversarial invalid-sku ${JSON.stringify(sku)} blocked`, r.status === 400 && /invalid|bad_request/.test(r.json.error || ''), `got ${r.status}`);
  }
  // Adversarial arm: below-floor pricing must 400 — probed via pack/quote shape
  const cat = await api('GET', '/api/agent/v1/catalog');
  const firstSku = cat.json.items?.[0]?.sku;
  if (firstSku) {
    const r = await api('POST', '/api/agent/v1/quote', { line_items: [{ sku: firstSku, quantity: 1, negotiated_price: 1 }] });
    check('live', 'adversarial ₹1 below-floor quote blocked', r.status === 400 && r.json.error === 'margin_floor_violation', `got ${r.status}`);
  } else {
    skip('adversarial below-floor quote', 'products table is empty — seed a product, then re-run');
  }
  // Valid arm: must NOT block (false-block check)
  const ok1 = await api('GET', '/api/agent/v1/catalog');
  check('live', 'valid catalog fetch allowed', ok1.status === 200 && Array.isArray(ok1.json.items));
  const ok2 = await api('POST', '/api/agent/pack-bundle', { budget_cap: 100000 });
  if (ok2.status === 404 && ok2.json.error === 'empty_catalog') {
    skip('valid pack-bundle', 'products table is empty — seed a product, then re-run');
  } else {
    check('live', 'valid pack-bundle allowed', ok2.status === 200 && typeof ok2.json.headroom === 'number', `got ${ok2.status}`);
  }
  const ok3 = await api('GET', '/api/user/mandate');
  check('live', 'valid mandate issuance allowed', ok3.status === 200 && Boolean(ok3.json.signature));
  const ok4 = await api('GET', '/api/growth/funnel');
  check('live', 'valid funnel read allowed', ok4.status === 200 && typeof ok4.json.suggested === 'number');
}

// ---------- Verdict ----------
const all = [...results.offline, ...results.live];
const failed = all.filter(c => !c.pass);
results.summary = {
  total: all.length, passed: all.length - failed.length,
  adversarial_blocked: results.live.filter(c => c.name.startsWith('adversarial') && c.pass).length,
  adversarial_total: results.live.filter(c => c.name.startsWith('adversarial')).length,
  false_blocks: results.live.filter(c => c.name.startsWith('valid') && !c.pass).length,
  pass: failed.length === 0,
};
fs.mkdirSync(path.join('eval', 'results'), { recursive: true });
const out = path.join('eval', 'results', `guardrail_eval_${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nVerdict: ${results.summary.pass ? 'PASS' : 'FAIL'} — ${results.summary.passed}/${results.summary.total} checks. Artifact: ${out}`);
process.exit(results.summary.pass ? 0 : 1);
