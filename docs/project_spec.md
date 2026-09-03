# Agentic Commerce Co-Pilot - Comprehensive Project Specification

This document provides a highly detailed, minute-by-minute rundown of all features, technical implementations, and architectural decisions within the Agentic Commerce Co-Pilot project. It is designed to be provided to an LLM evaluator to assess the depth, robustness, and completeness of the platform.

## 1. Executive Summary
A B2B AI-driven autonomous checkout platform integrated with Razorpay. It allows buyers to interact with an AI Sales Engineer to explore catalogs, negotiate prices, and create invoices. If authorized by a CFO Mandate, the agent can autonomously settle payments via Razorpay. The system implements banking-grade security, atomic database locks, and a full cryptographic audit ledger.

## 2. Technical Stack
- **Frontend**: React 18, Vite, Tailwind CSS, shadcn/ui, Recharts, Framer Motion, HTML2Canvas + jsPDF (for high-fidelity PDF generation).
- **Backend**: Express.js, Node.js (deployed via Vercel serverless functions).
- **Database**: Neon (Serverless Postgres).
- **AI/LLM**: Mistral API for function-calling and unstructured data parsing (with fallback modes).
- **Payments**: Razorpay Node SDK (Orders, Payment Links, Recurring/Mandate, Route).
- **Storage/Web3**: IPFS via Lighthouse (for immutable invoice anchoring).

## 3. Core AI Agent & Orchestrator (`/api/agent/chat`)
The AI Agent is a Mistral-powered conversational bot functioning as a Senior Enterprise Sales Engineer.
- **Function Calling**: The agent has native tool access to `search_catalog`, `suggest_upsell_bundle`, `create_invoice`, `update_invoice`, `cancel_invoice`, and `trigger_payment`.
- **Graduated Negotiation Logic (The Ladder)**:
  1. Starts at List Price.
  2. 5% discount (Soft Concession).
  3. 10% discount (Bundle Anchor - only if another item is added).
  4. 15% discount (Volume/Term Lock).
  5. 20% discount (Final Break-Even Offer).
- **Hard Constraints**: The agent is programmatically and strictly instructed **never** to sell below the database-defined `margin_floor` of a product.
- **Strict Tone Compliance**: The agent is forbidden from proactively mentioning its negotiation bounds, rules, or limits. It must speak confidently, never apologize, and never say "I'm just an AI."
- **Idempotency in Chat**: The UI ensures `tool_calls` and normal responses are parsed sequentially without duplicating responses in the chat history state.

## 4. CFO Mandate & Autonomous Settlement (x402 Protocol)
- **Delegated AI Budgets**: Buyers can allocate a `daily_budget` and a `per_transaction_max` to their AI agent.
- **Machine-to-Machine API (x402)**: The AI buyer uses `/api/agent/v1/catalog` to discover products, `/api/agent/v1/quote` to negotiate prices, and receives an HTTP `402 Payment Required` challenge along with a Razorpay `order_id` in the `Www-Authenticate` header. It then completes the handshake via `/api/agent/v1/settle`.
- **Tokenized Settlement**: The buyer agent securely settles 402 challenges via Server-to-Server (S2S) calls using a saved Razorpay Mandate/Token (Card on file), completely bypassing human checkout UI.
- **Safety Gate**: Before an autonomous payment (`trigger_payment`) succeeds, the backend checks:
  - Is the invoice amount $\le$ `delegation_max`?
  - Has the `daily_limit` been exhausted?
  - Does the invoice have a `compliance_score` $\ge$ 85? (Crucially: The agent cannot score its own invoices. A human must click 'Validate', or it must go through a rigid external evaluation).
- **S2S Charging**: If all gates pass and a Razorpay Mandate token is present, the backend uses the Razorpay API to autonomously capture the funds without human clicks. If no token is present, it elegantly falls back to generating a Razorpay Payment Link for human escalation.

## 5. Security, Concurrency, and Audit Trails
- **TOCTOU Guard (Time-Of-Check to Time-Of-Use)**: Payments and claims utilize strict Postgres row-level atomic locks: `UPDATE invoices SET status = 'processing' WHERE id = $1 AND status NOT IN ('paid', 'processing') RETURNING id`. This guarantees zero double-spend anomalies even if 10 agents try to pay concurrently.
- **Webhook Resilience**: 
  - Validates HMAC signatures using raw payload bytes.
  - Fail-closed design: If `RAZORPAY_WEBHOOK_SECRET` is missing in the environment, all webhooks are rejected.
  - Amount Guards: Prevents "payment successful" state if the Razorpay captured amount differs from the internal DB `grand_total` by even 1 paisa.
- **Cryptographic Hash Chain (Ledger)**: Every critical action (invoice creation, webhook arrival, payment attempt) writes to `audit_logs`. Each row calculates a SHA-256 hash incorporating the previous row's hash (`hash = SHA256(prev_hash + action + details)`). The frontend includes a "Verify Integrity" button that recalculates the entire chain in-browser to detect database tampering.

## 6. Dynamic Tax Splitting (Razorpay Route)
- Demonstrates B2B tax calculation based on GSTIN (Goods and Services Tax Identification Number) state codes (first two digits).
- **Intra-state (Same State)**: Calculates tax as 9% CGST (Central) and 9% SGST (State).
- **Razorpay Route Integration**: The backend automatically constructs Razorpay Route transfer arrays to split the calculated tax amounts to designated sub-merchant accounts at the moment of payment capture, simulating a compliance withholding model (note: does not natively remit to government tax nodal accounts).

## 7. Campaigns & Upsell Orchestrator
- **CFO Campaign Manager**: Merchants can launch bulk upsell campaigns targeting specific buyer segments (e.g., users who bought Product A but not Product B).
- **Dry-Run Preview**: Simulates which invoices/users will be affected before execution.
- **LLM Upsell Tool**: The agent proactively checks the campaign database and pushes complementary bundles to the buyer during chat, actively increasing AOV (Average Order Value) if the buyer has budget remaining.

## 8. Frontend & UI Polish
- **Invoice Detailing**: Real-time rendering of complex invoices with tax breakdowns, status badges, and transaction hashes.
- **Universal PDF Exporter**: Replaces basic table generation with a high-fidelity hidden-DOM renderer. It renders the exact React `<InvoicePreview>` component into a hidden `800px` container, captures it via `html2canvas`, and exports a pixel-perfect `jsPDF` document. This is used uniformly across the "My Orders" page, "Agent Chat", and "Invoice Details".
- **Resilient Fallback UI**: If the LLM goes offline, the chat interface dynamically injects a "Manual Fallback Cart" (a fully rendered UI catalog inside the chat window) allowing the user to select items and pay manually without breaking the flow.
- **Responsive Layouts**: Meticulous attention to Tailwind spacing (`gap-4`, `shrink-0`) and typography (`font-mono` for IDs) to ensure UI elements do not overlap or break on mobile devices.

## 9. Next-Gen Tech / Hacks
- **IPFS Anchoring**: Finalized invoices can be committed to the Lighthouse IPFS network, returning a permanent CID (Content Identifier) proving the invoice existed at a specific point in time.
- **Interactive Markdown**: The UI uses custom React-Markdown components to render real-time interactive widgets directly within the chat stream.
