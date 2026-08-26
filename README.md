# Nikunj × RazorPay | Agentic Commerce Co-Pilot 🚀

An enterprise-grade, dual-system AI billing architecture built for **Razorpay AI Buildathon 2026 (Track 01: AI Growth & Agentic Commerce)**.

This platform proves that B2B enterprises can safely adopt AI for financial workflows by separating tasks into two distinct layers: a **Human-in-the-Loop Co-Pilot** for bespoke high-value contracts, and a **Level-5 Autonomous Agent** for strictly bounded, high-speed micro-transactions.

---

## 🏆 Key Hackathon Features

### 1. Dual-System AI Architecture
* **AI Co-Pilot (Form):** Unstructured text goes in, structured JSON comes out. Perfect for accountants drafting complex invoices that require manual human review and a "Validate" click.
* **Agentic Chat (Autonomous):** A conversational agent capable of executing database commands and triggering real financial transactions via Razorpay's S2S API without a frontend widget.

### 2. Bounded Budgets & Explainable Risk (The Safety Gate)
Enterprises won't use agents that can drain their bank accounts. We implemented an **ERC-8004 inspired Delegation Limit**. 
* The user sets a maximum autonomous budget (e.g., ₹50,000).
* If the Agent tries to settle an invoice for ₹1,00,000, the backend cryptographically rejects the API call, logs the breach attempt, and gracefully escalates to a human checkout widget.

### 3. True Server-to-Server (S2S) Autonomous Settlement
Most hackathon projects just mock the database update. When our Agent pays an invoice, it genuinely integrates with **Razorpay's Orders API** in the background, generates a real Razorpay `order_id`, and permanently anchors that TX Hash onto the invoice and audit trail.

### 4. AI Growth & Cross-Selling
The Agent isn't just an accountant; it's a salesman. It dynamically reads the `catalog.json` and natively injects upsell suggestions into the chat (e.g., suggesting Firewalls when a user buys a Webex License). 

### 5. Decentralized Cryptographic Audit Trails
Every action the AI takes (creating, validating, or paying an invoice) is hashed using SHA-256 and appended to an immutable Audit Ledger. The final invoices are uploaded to the decentralized **IPFS network** via Lighthouse Web3, ensuring permanent, tamper-proof proof of AI actions.

---

## 👨‍⚖️ Judges: How to Test the Autonomous Safety Gate

1. Clone the repo, `npm install`, and `npm run dev`.
2. Go to the **Settings** page and set your **Agent Delegation** limit to `₹50,000`.
3. Open the **Agent Chat** (floating bottom right).
4. **Trigger the Block:** Type *"Generate an invoice for ₹1,00,000 and pay it"*. Watch the Agent get mathematically blocked by the backend and escalate to human review.
5. **Trigger the Success:** Type *"Generate an invoice for ₹5,000 and pay it"*. Watch the Agent bypass the checkout widget entirely, hit the Razorpay API, and return a real **Razorpay TX ID** in the chat.

---

## 🛠️ Tech Stack

* **Frontend:** React, Vite, Tailwind CSS, Lucide Icons
* **Backend:** Node.js, Express
* **Database:** Neon Serverless PostgreSQL
* **AI:** Mistral AI (Function Calling, JSON schema enforcement)
* **Payments:** Razorpay Node SDK (Testnet)
* **Web3/Storage:** Lighthouse IPFS SDK, SHA-256 Hashing

---
*Built with NO AI SLOP. Strictly engineered for Enterprise B2B.*
