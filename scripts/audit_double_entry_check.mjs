/**
 * Guard: every SUCCESSFUL settlement write must be double-entry.
 *
 * Regression this pins: settlement success rows were written only under
 * invoice.user_id (the merchant). The Audit Trail GET filters by
 * user_id = req.user.id, so buyers never saw their successful transactions,
 * while blocks (logged under req.user.id) showed up fine. Success paths must
 * go through appendAuditBoth([owner, payer]) — same pattern as x402 b2b-pay.
 *
 * Static, offline check. Exit 1 if a success action is written single-sided
 * or the webhook invoice lookup loses buyer_id.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'index.js'), 'utf8');

// Money-cleared actions that must never be single-sided again.
const SUCCESS_ACTIONS = [
  'settlement_verified',
  'settlement_auto',
  'settlement_captured',
  'x402_sale_settled',
  'x402_purchase_paid',
];

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

// Collect every audit call site: [userExpr, action]. The bracket alternative
// must come first so array-form targets like [inv.user_id, req.user.id] are
// captured whole instead of stopping at the comma inside the brackets.
const sites = [...src.matchAll(/appendAudit(?:Both|Log)\(\s*(\[[^\]]*\]|[^,]+?)\s*,\s*\{[^}]*?action:\s*'([^']+)'/gs)]
  .map(([, userExpr, action]) => ({ userExpr: userExpr.trim(), action }));

const isOwnerOnly = (expr) => /^(invoice|inv)\.user_id$/.test(expr);

// 1. Single-call success paths must fan out to owner AND payer.
for (const action of ['settlement_verified', 'settlement_auto', 'settlement_captured']) {
  const forAction = sites.filter((s) => s.action === action);
  if (forAction.length === 0) { fail(`success action '${action}' no longer written anywhere`); continue; }
  for (const s of forAction) {
    if (!s.userExpr.startsWith('[') && isOwnerOnly(s.userExpr)) {
      fail(`'${action}' written owner-only via appendAuditLog(${s.userExpr})`);
    }
  }
  if (forAction.every((s) => s.userExpr.startsWith('appendAuditLog') && isOwnerOnly(s.userExpr))) {
    fail(`'${action}' has no payer-side write`);
  }
}

// 2. The x402 path double-enters via a PAIR of single-sided calls (sale on the
//    owner side, purchase on the payer side) — both must exist.
const hasSale = sites.some((s) => s.action === 'x402_sale_settled' && isOwnerOnly(s.userExpr));
const hasPurchase = sites.some((s) => s.action === 'x402_purchase_paid' && /req\.user\.id/.test(s.userExpr));
if (!hasSale || !hasPurchase) {
  fail('x402 b2b-pay pair incomplete (need x402_sale_settled on owner side AND x402_purchase_paid on payer side)');
}

if (!/appendAuditBoth\(\[.*(?:buyer_id|req\.user\.id).*\]/.test(src)) {
  fail('appendAuditBoth is never called with a payer side (buyer_id / req.user.id)');
}

// 3. The helper must exist and fan out to every id.
if (!src.includes('async function appendAuditBoth(userIds, data)')) {
  fail('appendAuditBoth helper is missing');
}

// 4. Webhook must SELECT buyer_id so the payer side can be credited.
const webhookSelect = src.match(/SELECT id, user_id, buyer_id, invoice_number, grand_total, status, tx_hash FROM invoices/);
if (!webhookSelect) {
  fail("webhook invoice SELECT no longer includes buyer_id");
}

if (failures) {
  console.error(`\n${failures} check(s) failed — a settlement success path went single-sided again.`);
  process.exit(1);
}
console.log('OK: all settlement success paths are double-entry (owner + payer).');
