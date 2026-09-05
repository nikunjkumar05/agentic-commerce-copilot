import Razorpay from 'razorpay';
import crypto from 'crypto';

// FAIL-LOUD (v2): the old 'dummy_key'/'dummy_secret' fallback sent fabricated
// credentials to Razorpay and surfaced as a cryptic 401 mid-payment. We now
// detect a missing configuration up front and refuse with an explicit error.
export class RazorpayNotConfiguredError extends Error {
  constructor(missingVars) {
    super(
      `Razorpay is not configured: set ${missingVars.join(', ')} in your environment. ` +
      'No order, payment, or signature verification was simulated.'
    );
    this.name = 'RazorpayNotConfiguredError';
    this.missingVars = missingVars;
  }
}

function requireRazorpayConfig() {
  const missing = [];
  if (!process.env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
  if (!process.env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
  if (missing.length > 0) {
    console.error(`[FAIL-LOUD] Razorpay refused: missing ${missing.join(', ')} — no simulated settlement.`);
    throw new RazorpayNotConfiguredError(missing);
  }
}

export function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

// LAZY INIT (required): the Razorpay SDK throws at construction when key_id is
// missing, which would crash the entire server at boot on machines without
// Razorpay env vars. We construct the instance on first use instead — after
// requireRazorpayConfig() has already produced a clear, honest error.
let _instance = null;
function getInstance() {
  requireRazorpayConfig();
  if (!_instance) {
    _instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _instance;
}

// Test-mode card used for the autonomous S2S payment.
// In LIVE mode this must be replaced by a saved customer token (mandate);
// we support both via env so the same code path runs in test & production.
const S2S_CREDENTIALS = {
  email: process.env.RAZORPAY_AGENT_EMAIL || 'agent@agentic-copilot.local',
  contact: process.env.RAZORPAY_AGENT_CONTACT || '9876543210',
  card: {
    number: process.env.RAZORPAY_TEST_CARD_NUMBER || '4111111111111111',
    name: process.env.RAZORPAY_TEST_CARD_NAME || 'Agentic Co-Pilot',
    expiry_month: process.env.RAZORPAY_TEST_CARD_EXP_MONTH || '12',
    expiry_year: process.env.RAZORPAY_TEST_CARD_EXP_YEAR || '34',
    cvv: process.env.RAZORPAY_TEST_CARD_CVV || '123',
  },
};

// Dynamic GST split: IGST (inter-state) vs CGST+SGST (intra-state),
// keyed off the first 2 digits of the seller's and buyer's GSTIN state codes.

function gstStateCode(value) {
  if (!value) return null;
  const m = String(value).match(/([0-9]{2})\d{13}/);
  if (m) return m[1];
  const m2 = String(value).match(/^\s*([0-9]{2})/);
  return m2 ? m2[1] : null;
}

export function computeTaxSplit({ subtotal, rate, sellerGstin, buyerGstin }) {
  const r = Number.isFinite(Number(rate)) ? Number(rate) : 18;
  const totalTax = (Number(subtotal) || 0) * (r / 100);
  const sCode = gstStateCode(sellerGstin);
  const bCode = gstStateCode(buyerGstin);
  const inter = Boolean(sCode && bCode && sCode !== bCode);
  const half = Math.round(totalTax / 2);
  if (inter) {
    return { mode: 'inter-state', rate: r,
      cgst: 0, sgst: 0, igst: totalTax, seller_state_code: sCode, buyer_state_code: bCode };
  }
  return { mode: 'intra-state', rate: r,
    cgst: half, sgst: totalTax - half, igst: 0, seller_state_code: sCode || null, buyer_state_code: bCode || null };
}
/**
 * Creates a new Razorpay Order for the agent settlement.
 * FEATURE: Uses Razorpay Route (Transfers) to autonomously split GST tax.
 *
 * @param {number} amount - The grand total amount in INR
 * @param {string} receipt - A unique receipt id (invoice id)
 * @param {number} taxAmount - The amount of GST tax to automatically split
 */
export async function createAgentSettlementOrder(amount, receipt, taxAmount = 0, taxSplit = null) {
  requireRazorpayConfig();
  // NUMERIC columns arrive from Postgres as strings ("9440.00") — coerce once
  // here so every money method below (.toFixed, Razorpay paise math) is safe
  // no matter which caller path (settle, auto-settle, b2b, checkout) we came from.
  amount = Number(amount) || 0;
  taxAmount = Number(taxAmount) || 0;
  const totalPaise = Math.round(amount * 100);
  const taxPaise = Math.round(taxAmount * 100);
  const linkedAccountId = process.env.RAZORPAY_LINKED_ACCOUNT_ID;

  const options = {
    amount: totalPaise,
    currency: 'INR',
    receipt: receipt,
  };

  // Razorpay Route (Autonomous Split Payment for GST)
  if (taxPaise > 0) {
    options.notes = {
      agent_autonomous_split: 'true',
      tax_split_paise: taxPaise.toString(),
      vendor_net_paise: (totalPaise - taxPaise).toString(),
      tax_split_reason: 'Autonomous GST Withholding by AI Agent (Razorpay Route)',
    };
    // Optional dynamic CGST/SGST/IGST split (computed at the call site from GSTin state codes);
    // reflected in the Route notes so the split is auditable and matches Indian GST law.
    const _split = taxSplit || null;
if (_split && _split.mode) {
  const cgst = _split.cgst || 0;
  const sgst = _split.sgst || 0;
  const igst = _split.igst || 0;
  options.notes.tax_mode = _split.mode;
  options.notes.gst_rate = _split.rate || null;
  options.notes.cgst_inr = cgst.toFixed(2);
  options.notes.sgst_inr = sgst.toFixed(2);
  options.notes.igst_inr = igst.toFixed(2);
  options.notes.seller_state_code = _split.seller_state_code || null;
  options.notes.buyer_state_code = _split.buyer_state_code || null;
  options.notes.tax_split_detail = _split.mode === 'intra-state'
    ? 'CGST ' + cgst.toFixed(2) + ' + SGST ' + sgst.toFixed(2)
    : 'IGST ' + igst.toFixed(2);
}

    if (linkedAccountId && linkedAccountId.startsWith('acc_')) {
      options.transfers = [{
        account: linkedAccountId,
        amount: taxPaise,
        currency: 'INR',
        notes: { reason: 'Automated GST Tax Withholding' },
        on_hold: 0,
      }];
    }
  }

  const order = await getInstance().orders.create(options);

  const settlementBreakdown = {
    vendor_share_inr: (amount - taxAmount).toFixed(2),
    tax_withheld_inr: taxAmount.toFixed(2),
    // Honest breakdown: when no Route linked account is configured, there is
    // no real tax-authority destination — say so instead of inventing one.
    tax_authority_account: linkedAccountId || null,
    split_mode: linkedAccountId ? 'route_live' : 'route_not_configured',
  };

  return { order, settlementBreakdown };
}

/**
 * True Autonomous S2S Settlement.
 *
 * Two real Razorpay modes (test & live compatible):
 *  1. SAVED TOKEN (per-user vault only): charges the buyer's own saved card
 *     token via POST /v1/payments/create/recurring — a genuine mandate payment
 *     with no UI. The token must come from the caller's DB row
 *     (`users.razorpay_token_id`); there is deliberately NO global env fallback,
 *     so one merchant's mandate can never settle another merchant's invoice.
 *  2. NO TOKEN: creates a real Razorpay Payment Link and returns it so a human
 *     can complete checkout (this is the graceful escalation path).
 *
 * @param {string} orderId - Razorpay order id (order_xxx)
 * @param {number} amount  - Amount in INR
 * @param {string} token   - Per-user saved payment token (mandate), or null
 * @returns {{ mode: 'mandate_captured'|'payment_link', via: string, payment?: object, paymentLink?: object }}
 */
export async function captureAutonomousPayment(orderId, amount, token = null, customerId = null) {
  requireRazorpayConfig();
  const totalPaise = Math.round(amount * 100);
  const via = 'per_user_vault';

  // --- Mode 1: Autonomous mandate charge with the buyer's own saved token ---
  if (token && customerId) {
    const payment = await s2sRequest('payments/create/recurring', {
      email: S2S_CREDENTIALS.email,
      contact: S2S_CREDENTIALS.contact,
      amount: totalPaise,
      currency: 'INR',
      order_id: orderId,
      customer_id: customerId,
      token: token,
      description: 'Agentic Autonomous Checkout',
    });

    // If the gateway authorized but did not auto-capture, capture explicitly
    let finalPayment = payment;
    if (payment.status === 'authorized') {
      finalPayment = await getInstance().payments.capture(payment.id, totalPaise, 'INR');
    }

    // Trust-but-verify: re-fetch from Razorpay and require captured + amount + order binding
    // Mirrors the human /verify path (payment.amount + order_id checks) — the
    // autonomous path must not be weaker. Docs: Orders amount is in paise, every
    // payment carries its order_id and amount in the same unit.
    const verified = await getInstance().payments.fetch(finalPayment.id);
    if (verified.status !== 'captured') {
      const err = new Error(
        `Agent settlement verification failed: payment ${verified.id} status='${verified.status}'`
      );
      err.payment = verified;
      throw err;
    }
    if (Number(verified.amount) !== totalPaise) {
      const err = new Error(
        `Agent settlement amount mismatch: expected ${totalPaise} paise for order ${orderId}, got ${verified.amount} paise (payment ${verified.id})`
      );
      err.payment = verified;
      throw err;
    }
    if (verified.order_id !== orderId) {
      const err = new Error(
        `Agent settlement order binding failed: payment ${verified.id} is for order ${verified.order_id}, expected ${orderId}`
      );
      err.payment = verified;
      throw err;
    }

    return { mode: 'mandate_captured', payment: verified, via };
  }

  // --- Mode 2: Real Payment Link (human escalation, no saved token yet) ---
  const paymentLink = await getInstance().paymentLink.create({
    amount: totalPaise,
    currency: 'INR',
    accept_partial: false,
    reference_id: orderId,
    description: `Agentic settlement for order ${orderId} — agent cannot charge without a mandate token`,
    customer: { name: S2S_CREDENTIALS.card.name, email: S2S_CREDENTIALS.email, contact: S2S_CREDENTIALS.contact },
    notify: { sms: false, email: false },
  });

  return { mode: 'payment_link', paymentLink, via: 'human_escalation' };
}

/** Minimal Razorpay REST caller for endpoints the SDK does not expose. */
async function s2sRequest(path, payload) {
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString('base64');

  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    const err = new Error(`Razorpay S2S ${path} failed: ${body.error?.description || res.statusText}`);
    err.error = body;
    throw err;
  }
  return body;
}

/**
 * Fetches a single payment from Razorpay — used by /verify to confirm amount
 * and capture status from the source of truth instead of trusting the client.
 */
export async function fetchPayment(paymentId) {
  requireRazorpayConfig();
  return getInstance().payments.fetch(paymentId);
}

/**
 * Fetches an order with its payments — used by idempotency guards and
 * reconciliation checks (e.g., verifying a webhook against source of truth).
 */
export async function fetchOrderWithPayments(orderId) {
  requireRazorpayConfig();
  const order = await getInstance().orders.fetch(orderId);
  let payments = [];
  try {
    const res = await getInstance().orders.fetchPayments(orderId);
    payments = res?.items || [];
  } catch {
    // Orders may have no payments yet; not an error for our purposes
  }
  return { order, payments };
}

/**
 * Verifies the signature from the Razorpay Webhook
 * FEATURE: Enterprise Grade Webhook Security
 */
export function verifyWebhookSignature(payloadBody, signature) {
  // FAIL-CLOSED: without a configured webhook secret there is no way to
  // verify provenance — never accept the request on a known default.
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[SECURITY] RAZORPAY_WEBHOOK_SECRET is not configured — rejecting webhook.');
    return false;
  }
  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadBody)
    .digest('hex');

  if (!signature || typeof signature !== 'string') return false;
  const a = Buffer.from(generatedSignature, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies the frontend checkout signature
 */
export function verifySignature(orderId, paymentId, signature) {
  // FAIL-CLOSED (security): with no RAZORPAY_KEY_SECRET there is no shared
  // secret to verify against. The previous 'dummy_secret' fallback let anyone
  // who read this source forge a valid checkout signature. Reject instead.
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error('[SECURITY] RAZORPAY_KEY_SECRET is not configured — rejecting checkout signature.');
    return false;
  }

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(orderId + '|' + paymentId)
    .digest('hex');

  if (!signature || typeof signature !== 'string') return false;
  const a = Buffer.from(generatedSignature, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
