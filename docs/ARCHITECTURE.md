# 🏗️ Architecture — Agentic Commerce Co-Pilot

```mermaid
flowchart TB
    subgraph CLIENT["React Frontend (Vite)"]
        UI_DASH["Dashboard<br/>(AI Lift funnel: suggested→accepted→paid)"]
        UI_CHAT["Agent Chat<br/>(tool-call executor)"]
        UI_INV["Invoice Co-Pilot<br/>(LLM → structured invoice)"]
        UI_PAY["Payment Page<br/>(human checkout)"]
        UI_AUDIT["Audit Trail<br/>(+ Verify Integrity button)"]
    end

    subgraph API["Express API (Vercel serverless)"]
        GATE{"Safety Gate<br/>compliance_score >= 85 (human-minted)<br/>AND amount <= delegation_max"}
        CLAIM["Atomic Claim<br/>UPDATE ... WHERE status NOT IN ('paid','processing')<br/>RETURNING id (TOCTOU guard)"]
        CHAT["Agent Orchestrator<br/>Mistral function-calling<br/>catalog injected → reasoned upsells"]
        SETTLE["Settlement Engine"]
        X402["x402 Loop<br/>b2b-buy → 402 challenge → b2b-pay"]
        WEBHOOK["Webhook Handler<br/>HMAC over RAW bytes · amount guard<br/>idempotent"]
        LEDGER["Audit Ledger<br/>SHA-256 hash-chain<br/>(hash ← prev_hash)"]
        VERIFY["Chain Verifier<br/>recompute + detect tampering"]
    end

    subgraph RZP["Razorpay (test mode)"]
        ORDERS["Orders API"]
        MANDATE["Recurring Payments API<br/>(S2S mandate charge)"]
        PLINK["Payment Links API<br/>(human escalation)"]
        ROUTE["Route Transfers<br/>(autonomous GST split)"]
        WH["Webhooks<br/>payment.captured / order.paid / payment.failed"]
    end

    DB[("Neon Postgres<br/>users · invoices · audit_logs")]
    IPFS["IPFS via Lighthouse<br/>(invoice anchoring)"]

    UI_CHAT --> CHAT
    UI_INV --> API
    UI_PAY --> API
    UI_AUDIT --> VERIFY

    CHAT --> "tool: create_invoice" --> GATE
    CHAT --> "tool: trigger_payment" --> GATE
    GATE -->|"pass"| CLAIM --> SETTLE
    GATE -->|"fail"| LEDGER
    GATE -->|"fail (agent can't self-grade<br/>compliance_score is human-minted)"| UI_PAY

    SETTLE --> ORDERS
    SETTLE -->|"mandate token present"| MANDATE
    SETTLE -->|"no token: honest escalation"| PLINK

    X402 --> ORDERS
    X402 --> MANDATE
    X402 --> PLINK

    SETTLE --> LEDGER
    X402 --> LEDGER
    WEBHOOK --> LEDGER

    WH --> WEBHOOK
    ORDERS -.-> WH
    MANDATE -.-> WH

    API --> DB
    LEDGER --> DB
    VERIFY --> DB
    UI_INV --> IPFS
```

## The three trust invariants

1. **No self-grading:** invoices start with `compliance_score = null`. Only a human validation run mints a score. The settlement gate (`score >= 85`) treats null as failing — *the agent is subject to its own guardrails* (`agent_gate_test.mjs` proves it).
2. **No double-spend:** every money path claims the invoice atomically (`UPDATE ... RETURNING id`, row-level lock). 10 concurrent claims → exactly 1 winner (`idempotency_test.mjs`).
3. **No silent mutation:** every action — create, block, settle, escalate, webhook, failure — appends to a SHA-256 hash-chain. `chain_test.mjs` tampers with a row and proves the chain pinpoints it.

## Payment modes (honest by design)

| Situation | What happens | Proof artifact |
|---|---|---|
| Mandate token configured | S2S charge via Recurring Payments API → capture → **re-fetch verified `captured`** | real `pay_...` on invoice + ledger |
| No token | Real **Payment Link** issued; challenge stays open | real `plink_...` + `settlement_escalated` ledger entry |
| Webhook confirms | Raw-byte HMAC + amount check + idempotent state flip | `payment_method='razorpay_webhook'`, ledger entry |
| Webhook secret missing | **Fail-closed** — webhook rejected (503/400), never trusted | code path in `razorpay.js` |
