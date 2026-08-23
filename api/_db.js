import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      is_verified INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      institution_name TEXT,
      institution_address TEXT,
      gst_number TEXT,
      recipient_name TEXT,
      recipient_address TEXT,
      recipient_gst TEXT,
      line_items JSONB DEFAULT '[]',
      subtotal REAL DEFAULT 0,
      tax_total REAL DEFAULT 0,
      grand_total REAL DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      status TEXT DEFAULT 'draft',
      cid TEXT,
      tx_hash TEXT,
      payment_method TEXT,
      compliance_score REAL,
      ai_suggestions JSONB DEFAULT '[]',
      invoice_date TEXT,
      due_date TEXT,
      milestones JSONB DEFAULT '[]',
      created_date TIMESTAMP DEFAULT NOW(),
      updated_date TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      invoice_id TEXT,
      invoice_number TEXT,
      amount REAL,
      agent_address TEXT,
      owner_address TEXT,
      tx_hash TEXT,
      details TEXT,
      created_date TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      public_settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
