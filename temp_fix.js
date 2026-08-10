const Database = require('better-sqlite3');
const db = new Database('./data/sexs.db');

console.log('Atualizando vendas extras para rejeitada...\n');

// Venda ID 31: Lubrificante Menta extra
const result1 = db.prepare(`
  UPDATE kit_sales 
  SET status = 'rejeitada', decided_at = datetime('now'), decided_by = 1
  WHERE id = 31
`).run();
console.log(`Venda ID 31 (Lubrificante Menta): ${result1.changes} registro atualizado`);

// Venda ID 34: Six Ball extra
const result2 = db.prepare(`
  UPDATE kit_sales 
  SET status = 'rejeitada', decided_at = datetime('now'), decided_by = 1
  WHERE id = 34
`).run();
console.log(`Venda ID 34 (Six Ball): ${result2.changes} registro atualizado`);

console.log('\n✅ Correção concluída!');
db.close();
