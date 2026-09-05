# Limitations & Honesty Notes — AgentPay Gateway (Track 01)

This document exists so judges never have to guess what is real, what is scoped, and what is stubbed.

## What is real (test-mode, verifiable)
- Razorpay Orders, Recurring mandate charge (`payments/create/recurring`) with
  re-fetch requiring `status='captured'`, Payment Links escalation, HMAC webhooks
  (`payment.captured` / `order.paid` / `payment.failed`) with raw-byte verification,
  amount guard, relationship guard, and `processed_webhook_events` dedup.
- Budget gates: per-transaction + atomic daily reserve (`UPDATE ... WHERE
  spent+X<=limit RETURNING`), SKU allowlist, canonical SKU margin-floor (`400`),
  atomic invoice claims, 5/min settle rate limit.
- Audit ledger: SHA-256 hash chain over the full row + `sequence_num` ordering,
  dual V1/V2 verification so pre-upgrade rows still validate.
- Machine commerce: `GET /api/agent/v1/catalog`, `POST /api/agent/v1/quote`
  (402 challenge with Razorpay `order_id`), `POST /api/agent/v1/settle`.

## What is scoped / simulated (do not mistake for production)
- **Razorpay Route tax split:** without a real `RAZORPAY_LINKED_ACCOUNT_ID`
  (`acc_...`), the split lives in Order `notes` (`split_mode='route_not_configured'`).
  It is auditable tax math, not a live transfer to a government nodal account.
- **UAP / ACP / AP2:** discovery documents (`/.well-known/uap.json`,
  `/.well-known/acp/feed.json`) and `POST /ap2/cart-mandate → 202` are address-book
  surface only. The live protocol is our x402-over-Razorpay loop; AP2 appears as a
  signed Intent Mandate artifact (`GET /api/user/mandate`), enforced server-side.
- **IPFS anchoring:** Lighthouse CID proves existence at a point in time; it is not
  bound to the payment hash and is not required for settlement.
- **Mandate storage:** tokens live per-user (`users.razorpay_token_id`,
  bound via the CFO Portal). There is no global/shared token — without a bound
  mandate the agent escalates to a Payment Link. Token vaulting is a test-mode
  checkout hand-off, not a full PCI vault.
- **Manual bank transfer:** free-text UTR is a reconciliation *claim* (`pending` +
  `manual_reconciliation_claimed`), never settlement. Only Razorpay-verified paths
  may mark `paid`; direct PUT to `paid` returns `403 manual_settlement_forbidden`.

## Proven by runnable scripts (commit the outputs)
- `node scripts/guardrail_eval.mjs` — 15 offline gate checks (HMAC, GST, ledger
  canonicalization, idempotency) + opt-in live adversarial probes
  (`EVAL_API_BASE` + `EVAL_JWT`). Invalid probes 400 before any Razorpay order.
- `node scripts/backfill_audit_hashes.mjs [--apply]` — migrates legacy V1 ledger
  hashes to V2; refuses to rewrite genuinely broken (tampered) chains.
- Growth funnel is demonstrated live in the UI: Dashboard AI Lift card
  (`suggested → accepted → paid`); paid moves only via real test-mode settlement.

## Known follow-ups (not fixed for the demo)
- Money columns migrated `REAL → NUMERIC(12,2)`; historical float rounding may leave
  1-paise display artifacts on old rows.
- Campaign funnel counts are demo-scale, not a statistically powered lift study.
