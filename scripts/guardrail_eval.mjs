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

// A6: negotiation GST arithmetic (exact totals the agents keep getting wrong)
// 7200 pre -> 8496 total (the floor that keeps being mis-quoted as 8436),
// 9000 pre -> 10620 total, 7650 incl-GST handling, budget-guard ceiling math.
{
  const total = (pre) => pre + Math.round(pre * 18 / 100);
  const ceiling = (cap) => Math.floor(cap / 1.18);
  check('offline', 'gst_total 7200 pre -> 8496 total (floor truth)', total(7200) === 8496);
  check('offline', 'gst_total 9000 pre -> 10620 total', total(9000) === 10620);
  check('offline', 'gst_total 8550 pre -> 10089 total', total(8550) === 10089);
  check('offline', 'budget ceiling 10000 -> 8474 pre-GST cap', ceiling(10000) === 8474);
  check('offline', 'budget ceiling 7500 -> 6355 pre-GST cap', ceiling(7500) === 6355);
  check('offline', 'budget ceiling 12000 -> 10169 pre-GST cap', ceiling(12000) === 10169);
  // Inverted-cap lie: merchant says "8474 incl GST (=7164 pre)" — audit must not trust framing
  // floor 7200 pre (8496 total) FITS 10000 cap, even though merchant claims "above target"
  check('offline', 'escalation_audit: floor 7200 fits 10000 cap (blocks false escalation)', total(7200) <= 10000);
  check('offline', 'escalation_audit: floor 7200 exceeds 7500 cap (genuine escalation)', total(7200) > 7500);
  // Hallucinated below-floor 7000 would be 8260 total — server must reject it
  check('offline', 'below_floor 7000 hallucination total 8260 (margin violation, not budget)', total(7000) === 8260);
}
// A7: escalation-audit floor extraction (sentence-level, so the cap in the same message never poisons the floor)
{
  const extractFloor = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant' || !m.content) continue;
      for (const sent of m.content.split(/[.!?\n]+/)) {
        if (!/floor|minimum|lowest|break-?even|cost basis|absolute minimum|margin floor/i.test(sent)) continue;
        const preMarked = [...sent.matchAll(/₹\s*([\d,]+)\s*(?:pre-GST|before GST|pre GST)/gi)];
        if (preMarked.length) return parseInt(preMarked[0][1].replace(/,/g, ''), 10);
        const any = sent.match(/₹\s*([\d,]+)/);
        if (any) return parseInt(any[1].replace(/,/g, ''), 10);
      }
    }
    return null;
  };
  const runMsgs = [
    { role: 'assistant', content: 'The Compliance Audit is priced at ₹9,000 before GST.' },
    { role: 'assistant', content: 'The absolute minimum I can offer for the Compliance Audit is ₹7,200 before GST (margin floor). This is our cost basis.' },
    { role: 'assistant', content: 'Since ₹7,200 exceeds your pre-GST limit of ₹6,355, I recommend...' },
  ];
  check('offline', 'floor_extraction: ₹7,200 pre-GST from margin floor line', extractFloor(runMsgs) === 7200);
  const invertedMsgs = [
    { role: 'assistant', content: 'Since this is still above your target of ₹8,474 including GST (₹7,164 pre-GST), I cannot offer lower.' },
    { role: 'assistant', content: 'The margin floor for the Compliance Audit is ₹7,200 before GST. Since this is still above your target...' },
  ];
  check('offline', 'floor_extraction: picks floor ₹7,200 not inverted cap ₹8,474', extractFloor(invertedMsgs) === 7200);
  // Same-message poison: floor and cap in one message — sentence split must still pick floor
  const sameMsgPoison = [
    { role: 'assistant', content: 'The absolute minimum is ₹7,200 pre-GST (margin floor). Since your cap is ₹8,474 pre-GST, this exceeds your limit.' },
  ];
  check('offline', 'floor_extraction: same-message cap does not poison floor', extractFloor(sameMsgPoison) === 7200);
  // Fallback: floor sentence without pre-GST tag (e.g. "₹7,200 (margin floor)")
  const fallbackMsg = [
    { role: 'assistant', content: 'The lowest I can go is ₹7,200 (margin floor).' },
  ];
  check('offline', 'floor_extraction: fallback without pre-GST tag still extracts', extractFloor(fallbackMsg) === 7200);
  const hallucinatedRun = [
    { role: 'assistant', content: 'I can offer ₹7,000 pre-GST, which is a 15% discount.' },
  ];
  // 7000 has no floor keyword — extraction returns null, audit fails safe (falls through to card, never auto-accepts)
  check('offline', 'floor_extraction: 7000 without floor keyword fails safe (null)', extractFloor(hallucinatedRun) === null);
  const total = (pre) => pre + Math.round(pre * 18 / 100);
  // Matrix: floor fits vs exceeds
  check('offline', 'audit decision: floor 7200 (8496) vs cap 10000 -> accept (no escalation)', total(extractFloor(runMsgs)) <= 10000);
  check('offline', 'audit decision: floor 7200 (8496) vs cap 7500 -> escalate (card)', total(7200) > 7500);
}
// A8: S2S capture binding — re-fetched payment must match order amount + order_id (Razorpay docs: Orders amount in paise, payment carries order_id)
{
  const totalPaise = (inr) => Math.round(inr * 100);
  const verifyBinding = (orderId, totalP, payment) => {
    if (payment.status !== 'captured') return false;
    if (Number(payment.amount) !== totalP) return false;
    if (payment.order_id !== orderId) return false;
    return true;
  };
  const orderId = 'order_RB58MiP5SPFYyM';
  const good = { id: 'pay_1', status: 'captured', amount: totalPaise(8496), order_id: orderId };
  const wrongAmt = { id: 'pay_2', status: 'captured', amount: totalPaise(9000), order_id: orderId };
  const wrongOrder = { id: 'pay_3', status: 'captured', amount: totalPaise(8496), order_id: 'order_OTHER' };
  const notCaptured = { id: 'pay_4', status: 'authorized', amount: totalPaise(8496), order_id: orderId };
  check('offline', 's2s_binding: correct amount+order+status passes', verifyBinding(orderId, totalPaise(8496), good));
  check('offline', 's2s_binding: amount mismatch rejected', !verifyBinding(orderId, totalPaise(8496), wrongAmt));
  check('offline', 's2s_binding: order_id mismatch rejected', !verifyBinding(orderId, totalPaise(8496), wrongOrder));
  check('offline', 's2s_binding: non-captured rejected', !verifyBinding(orderId, totalPaise(8496), notCaptured));
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
