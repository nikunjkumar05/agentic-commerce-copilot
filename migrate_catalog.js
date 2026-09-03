import { query, initDb } from './api/_db.js';
import fs from 'fs';
import path from 'path';

async function migrate() {
  await initDb();
  const file = JSON.parse(fs.readFileSync('./public/catalog.json', 'utf-8'));
  const catalog = file.catalog || [];
  
  // Use a default user ID for demo purposes
  const userRes = await query('SELECT id FROM users LIMIT 1');
  const userId = userRes.rows[0]?.id || 'demo-user';

  for (const item of catalog) {
    const id = crypto.randomUUID();
    const marginFloor = Math.round(item.price * 0.8); // Default margin floor is 20% discount
    await query(
      'INSERT INTO products (id, user_id, name, description, price, margin_floor) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [id, userId, item.name, item.description, item.price, marginFloor]
    );
  }
  console.log('Migrated', catalog.length, 'products into DB.');
  process.exit(0);
}

migrate().catch(console.error);
