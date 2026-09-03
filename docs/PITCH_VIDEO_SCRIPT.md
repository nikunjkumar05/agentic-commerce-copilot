# 🎬 5-Minute Pitch Video Script — Track 01

**Rule: every claim on screen must be backed by something the viewer can verify in the repo (code, test, or live Razorpay dashboard).**

## [0:00–0:30] Hook + Problem
> "Enterprises want AI agents that can spend money. The blocker isn't capability — it's trust: who stops an agent from overspending? Who proves what the agent did?"

Show: Dashboard (clean UI) → one line: "This is an Agentic Commerce Co-Pilot where **every money action is explainable, bounded, gated, and cryptographically audited**."

## [0:30–1:30] The Safety Gate (bounded agency)
Action: Settings → set Delegation Limit ₹50,000 → Agent Chat → type *"Generate an invoice for ₹1,00,000 and pay it"*.
- Agent **blocked by the backend** (show the 403 + the `settlement_blocked` entry in the Audit Trail page).
- Narration: "The limit lives in the database, not the prompt — the client cannot talk its way past it."

## [1:30–2:45] Real S2S Settlement (no checkout widget)
Action: *"Generate an invoice for ₹5,000 and pay it"*. Then run validation as the human.
- Show the two honest modes:
  - **Mandate mode:** real Razorpay `pay_...` ID, verified `status=captured` by re-fetching from Razorpay (show `captureAutonomousPayment` in `api/razorpay.js`).
  - **No token?** The agent escalates to a **real Payment Link** (`plink_...`) — it knows its limits.
- Pay the payment link live → webhook fires → HMAC-verified, amount-checked, idempotent → invoice flips to `paid`.

## [2:45–3:45] Agent-to-Agent: x402 end to end
Terminal (from README):
```bash
curl -X POST .../api/agent/b2b-buy   # → HTTP 402 challenge (order_id, invoice_id)
curl -X POST .../api/agent/b2b-pay   # → buyer agent settles or escalates
```
- Two **distinct identities**: invoice in the merchant's books, recipient is the buyer agent. Show `x402_test.mjs` output.
- Narration: "This is the 'make a merchant transactable by an AI buyer end to end' story — with audit entries on **both** sides."

## [3:45–4:30] AI Growth — measured, not claimed
- Agent suggests an upsell **with a reason** (catalog-grounded, no hallucinated prices — show the catalog injected into the system prompt).
- Dashboard **AI Lift** card: `suggested → accepted → paid` funnel + "X% of paid volume, Y agent-settled".
- Narration: "Growth here is a measured funnel, not a vanity counter."

## [4:30–5:00] Proof, not promises
- Audit Trail → **Verify Integrity** → "Chain Validated".
- Tamper a row in the DB → verify again → **"Tampering Detected: block <id>"**.
- Close: "Tests prove every claim: webhook HMAC, race-safety, ledger tamper-detection — `node webhook_test.mjs && node idempotency_test.mjs && node chain_test.mjs`."
- Final card: **"Every money action explainable, bounded, gated."**

---

### Recording checklist
- [ ] Razorpay test dashboard visible when a real `pay_`/`plink_` ID appears
- [ ] Cursor slow on key code lines (`compliance_score: null`, atomic claim SQL, HMAC raw-body)
- [ ] No fake data on screen (seeds have no fake CIDs/tx hashes)
- [ ] Demo Mode badge visible if Mistral key absent — honesty is part of the pitch
