# 🎬 5-Minute Pitch Video Script — Track 01

**Rule: every claim on screen must be backed by something the viewer can verify in the repo (code, test, or live Razorpay dashboard).**

## [0:00–0:20] Hook + problem
> "Enterprises want AI agents that can spend money. The blocker isn't capability — it's trust: who stops an agent from overspending? Who proves what the agent did?"

Show: Dashboard → one line: "Agentic Commerce Co-Pilot — **every money action explainable, bounded, gated, cryptographically audited**."

## [0:20–1:50] AI buyer buys end to end (the track, verbatim — UI only)
Agent Chat (buyer role) — search catalog → negotiate → invoice → settle:
- Show the chat upsell (`suggest_upsell_bundle` inside budget headroom), then the settle: real `pay_...` (mandate bound) or real `plink_...` escalation (no mandate).
- Catalog → **AI-Sellability Score**: the merchant side of "transactable" — scan, auto-fix missing HSN, View JSON-LD (what AI buyers read).
- Narration: "Make a merchant transactable by an AI buyer end to end — done, all in the UI."

## [1:50–3:20] Gated money + graceful failure (the bar, verbatim)
- Settings → cap ₹50,000 → chat *"invoice for ₹1,00,000 and pay it"* → **403** + `settlement_blocked` in Audit Trail.
- Audit Trail → **Failure Theater**: halt settlement → next settle returns `503 settlement_halted` (audited); simulate LLM outage → chat drops into manual cart checkout.
- Below-floor quote: `negotiated_price: 1` → `400 margin_floor_violation` **before** any Razorpay order exists.
- Narration: "Limits live in the database and in deterministic gates — the LLM cannot talk its way past them. `node scripts/guardrail_eval.mjs` proves it: 15/15 offline gates, adversarial API probes blocked, zero false blocks."

## [3:20–4:20] Growth, measured (UI only)
- Campaigns → launch bulk upsell → Dashboard AI Lift card: `suggested → accepted → paid` ticks live.
- Pay one invoice in test mode → webhook → `paid` moves on screen; no terminal needed.
- Pack-bundle: `POST /api/agent/pack-bundle` fills revealed-budget headroom with the highest-margin complement — deterministic math, not LLM vibes.

## [4:20–5:00] Proof, not promises
- Audit Trail → **Verify Integrity** → "Chain Validated" (full-row SHA-256 chain, `timingSafeEqual` HMACs).
- Tamper one row → "Tampering Detected: block \<id\>". Legacy rows? `node scripts/backfill_audit_hashes.mjs` migrates V1→V2, refuses to touch genuinely broken chains.
- Close on `docs/limitations.md`: Route split is notes-only without a linked account, UAP/ACP are discovery stubs, mandates are per-user by design. "Every money action explainable, bounded, gated."
- Final card: **test commands + funnel number + limitations link.**

## [0:00–0:30] Hook + Problem
> "Enterprises want AI agents that can spend money. The blocker isn't capability — it's trust: who stops an agent from overspending? Who proves what the agent did?"

Show: Dashboard (clean UI) → one line: "This is an Agentic Commerce Co-Pilot where **every money action is explainable, bounded, gated, and cryptographically audited**."

### Recording checklist
- [ ] Razorpay test dashboard visible when a real `pay_`/`plink_` ID appears
- [ ] `node scripts/guardrail_eval.mjs` output on screen (15/15 + live probes)
- [ ] Dashboard AI Lift funnel visible on the growth slide
- [ ] No fake data on screen (demo seeds labeled DEMO; paid moves only via real test payment)
- [ ] Demo Mode badge visible if Mistral key absent — honesty is part of the pitch
