# Agentic Commerce Co-Pilot

**Razorpay AI Buildathon 2026 Submission**  
**Track:** 01 — AI Growth & Agentic Commerce

Agentic Commerce Co-Pilot is a next-generation platform designed to make merchants natively transactable by AI buyers. By bridging the gap between legacy invoices and the incoming wave of agent-to-agent commerce, this project enables AI agents to autonomously audit, approve, and settle B2B payments using Razorpay infrastructure.

##  The Vision: Why Now?

With the global protocol race (ACP, AP2, **x402**) and the rise of autonomous agents, B2B commerce is shifting from human-to-human to agent-to-agent. 

This platform acts as the bridge. It allows a business (e.g., a government institution or enterprise) to delegate a budget to an **ERC-8004 AI Agent**. This AI agent can then ingest vendor invoices, score them for compliance, and execute bounded, gated payments via Razorpay—entirely autonomously.

##  Key Features (Hitting the Track 01 Bar)

- **Agent-Readable Invoices:** Uses LLMs (via Mistral) to ingest traditional invoices and convert them into structured, agent-readable JSON.
- **ERC-8004 Agent Delegation:** Businesses set strict bounds (e.g., Maximum ₹100,000, 30-day expiry) on their autonomous agents.
- **Gated Autonomy:** Every money action is explainable. The AI Risk Manager generates a `compliance_score`. The agent only executes Razorpay settlements if the score is highly confident.
- **Graceful Failures:** If an invoice exceeds the delegated budget or fails the compliance check, the agent gracefully halts the transaction, logs the failure, and escalates to a human controller.
- **Immutable Audit Trail:** Every validation, delegation, and settlement is logged cryptographically (x402/Web3-inspired architecture) for undisputed record-keeping.

## ⚙️ Tech Stack

- **Frontend:** React, Tailwind CSS, Shadcn UI, Vite
- **Backend:** Node.js, Express, PostgreSQL
- **AI / LLM:** Mistral API (mistral-large-latest)
- **Payments:** Razorpay Test APIs

##  Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL Database
- Razorpay Test Account
- Mistral API Key

### Local Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/nikunjkumar05/agentic-commerce-copilot.git
   cd agentic-commerce-copilot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Create a `.env.local` and `.env` file in the root directory:
   ```env
   # Database & Backend Config
   DATABASE_URL=your_postgres_connection_string
   PORT=3001
   
   # AI Configuration
   MISTRAL_API_KEY=your_mistral_api_key
   
   # Razorpay Config
   RAZORPAY_KEY_ID=your_razorpay_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_key_secret
   ```

4. **Run the Application:**
   Start both the React frontend and Express backend concurrently:
   ```bash
   npm run dev:all
   ```

5. **Usage:**
   - Navigate to `http://localhost:5173`
   - Register a demo account.
   - Go to an invoice, navigate to the **Payment** tab, and configure your AI Agent's budget delegation.
   - Run the Agent Settlement to see the autonomous Razorpay checkout flow in action!

## Architecture Notes (Audit & Explainability)

In compliance with the track rubric, the `agent_audit_logs` table maintains a strictly append-only record of all agent interactions. The system natively handles exceptions—such as AI hallucination or out-of-bounds payment requests—by failing closed and enforcing human-in-the-loop (HITL) manual checkout.

