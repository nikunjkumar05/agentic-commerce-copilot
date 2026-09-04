import 'dotenv/config';
import fs from 'fs';
import { query } from '../api/_db.js';

export async function seedCatalog() {
  const raw = fs.readFileSync('public/.well-known/agent-catalog.json', 'utf8').replace(/^\uFEFF/, '');
  const { catalog } = JSON.parse(raw);
  const userRes = await query("SELECT id FROM users WHERE role = 'merchant' LIMIT 1");
  const merchantId = userRes.rows[0]?.id || (await query('SELECT id FROM users LIMIT 1')).rows[0]?.id || 'default-merchant';
  
  let inserted = 0;
  for (const item of catalog) {
    const marginFloor = Math.round(item.price * 0.8);
    const existing = await query('SELECT id FROM products WHERE sku = $1', [item.id]);
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO products (id, user_id, sku, name, description, price, margin_floor, hsn_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [item.id, merchantId, item.id, item.name, item.description, item.price, marginFloor, item.hsn_code || '998313']
      );
      inserted++;
      console.log(`[SEED] Added ${item.name} (${item.id}) - ₹${item.price}`);
    }
  }

  const allProds = await query('SELECT sku, name, price FROM products');
  console.log(`[SEED] Done. ${inserted} new products inserted. Total products in catalog: ${allProds.rows.length}`);
}

seedCatalog().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
