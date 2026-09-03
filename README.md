# Nikunj × RazorPay | AgentPay Gateway: Machine Checkout for Razorpay 🚀

An enterprise-grade AI billing architecture built for **Razorpay AI Buildathon 2026 (Track 01: AI Growth & Agentic Commerce)**.

### The Core Insight: A Structurally New Pricing Surface
**An AI buyer discloses its budget. A human buyer never does.**
When an agent shows up saying *"I need 20 EDR licenses, ₹40,000 authorized, ₹25,000 per transaction,"* the merchant learns something no human checkout has ever surfaced: the exact shape of the buyer's willingness-to-pay and authority envelope.

Agent-native selling isn't just "a chatbot that upsells." It's **bundle construction against a revealed constraint**. The merchant computes the highest-margin basket that still clears the buyer's stated caps, in one round trip, with no negotiation friction, no cart abandonment, and no human hesitation. We built the infrastructure to safely capture this incremental revenue.

---

## 🏆 Key Hackathon Features

### 1. The Bounded Policy Engine (Safety Gates)
Enterprises won't let agents buy if they can drain their bank accounts. We implemented a **Deterministic Mandate Check**. 
* The CFO issues a mandate (allowed SKUs, per-transaction cap, daily cap).
* If the Agent tries to settle an invoice that exceeds these caps or buys unauthorized SKUs, the backend cryptographically rejects the API call, logs the breach, and gracefully escalates to an inline human checkout widget.

### 2. True Server-to-Server (S2S) Autonomous Settlement
Most hackathon projects just mock the database update. Our Agent performs a **real Razorpay payment**:
* **Mandate mode**: The Agent charges a saved mandate via Razorpay's Recurring Payments API, then **re-fetches the payment and only trusts it when Razorpay reports `status = 'captured'`**. 
* **Escalation mode**: The Agent knows its limits. If blocked, it creates a **real Razorpay Payment Link** inline.
* **Server-confirmed settlement**: Razorpay webhooks are HMAC-verified, amount-checked, and processed **idempotently**.

### 3. AI Growth: Revealed-Budget Bundling
The Agent dynamically reads the `catalog.json` and natively injects upsell suggestions (e.g., adding a Global CDN) that perfectly pack the remaining headroom in the buyer's disclosed budget. 

### 4. Cryptographic Audit Trails
Every action the AI takes (creating, validating, or paying an invoice) is hashed using SHA-256 and appended to an immutable Audit Ledger. This provides the mathematical proof required for dispute resolution in agent-to-agent commerce.

---

## 📜 Proposal: The Razorpay 402 Profile
To standardize how AI agents transact on Indian rails, we are open-sourcing a draft protocol specification defining how HTTP `402 Payment Required` maps cleanly to Razorpay Orders. 

* **The Challenge:** Agents making `GET /catalog` requests without auth receive a `402` with a `Www-Authenticate: Razorpay` header containing a Razorpay `order_id` and an amount.
* **The Mandate Payload:** The agent signs the `{order_id, amount, invoice_hash}` with its registered key, proving it has a CFO-issued mandate.
* **The Fulfillment:** The agent posts the signed payload back. The merchant captures via S2S Recurring Mandate API.
* **Finality:** Wait for `payment.captured` webhook before issuing the resource.

---

## 👨‍⚖️ Judges: How to Test the Autonomous Safety Gate

### Setup
1. Clone the repo, `npm install`, and configure `.env` (see `.env.example` — Razorpay test keys, Neon DB URL, optional Mistral key).
2. `npm run dev:all` (frontend + API together).

### The Safety Gate demo
3. Go to the **Settings** page and set your **Per-Transaction** cap to `₹50,000` and **Daily Autonomous Spend** to `₹50,000` (both enforced server-side).
4. Open the **Agent Chat** (floating bottom right).
5. **Trigger the Block:** Type *"Generate an invoice for ₹1,00,000 and pay it"*. The Agent gets mathematically blocked by the backend and escalates to human review — the block is written to the audit ledger.
6. **Trigger the Settle:** Type *"Generate an invoice for ₹5,000 and pay it"*.
   * **Without a mandate token:** the Agent escalates to a real Razorpay **Payment Link** (a live `plink_...` URL you can open and pay) — honest human-in-the-loop handoff.
    * **With a mandate token** (per-user, via the CFO Portal in **Settings → Razorpay Mandate**: complete one test-mode checkout, then bind the returned `customer_id` + `token` with `POST /api/user/razorpay-mandate` — no shared env token exists by design): the Agent charges **fully autonomously, S2S**, and returns a real **`pay_...`** ID verified as `captured` by Razorpay — no UI involved.

### Cryptographic ledger demo
7. Open the **Audit Trail** page → click **Verify Integrity** → *"Chain Validated"*.
8. Tamper with any audit row directly in the database (e.g. change an `amount`), then verify again — the chain **mathematically detects and pinpoints the tampered entry**.

### Run our engineering tests
```bash
node test-rzp.mjs       # Verify Razorpay integration keys & webhooks
node test-tok.mjs       # Verify Razorpay recurring mandate token S2S calls
node test-pay.mjs       # End-to-end payment creation test (idempotency checked)
node test-charge.mjs    # Agent safety gate bounds test via direct API charge
node test-schema.mjs    # Validate PostgreSQL DDL schema & constraints
```

📖 Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 5-minute pitch script: [docs/PITCH_VIDEO_SCRIPT.md](docs/PITCH_VIDEO_SCRIPT.md)

---

## 🛠️ Tech Stack

* **Frontend:** React, Vite, Tailwind CSS, Lucide Icons
* **Backend:** Node.js, Express
* **Database:** Neon Serverless PostgreSQL
* **AI:** Mistral AI (Function Calling, JSON schema enforcement)
* **Payments:** Razorpay Node SDK + REST — Orders API, Recurring Payments (e-mandate S2S), Payment Links, Route tax-split, HMAC-verified webhooks
* **Web3/Storage:** Lighthouse IPFS SDK, SHA-256 Hashing

---
*Built with NO AI SLOP. Strictly engineered for Enterprise B2B.*
