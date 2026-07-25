/**
 * Backfill da capability `pix_payments` nas contas conectadas já existentes.
 *
 * Uso (na raiz da API, com o .env de produção carregado):
 *   node scripts/backfill-pix-capability.js
 *
 * Percorre todas as empresas com stripe_account_id preenchido e solicita a
 * capability de Pix em cada conta conectada. Idempotente: rodar mais de uma vez
 * não causa problema. Contas que ganharem novas exigências (requirements) só
 * passam a receber via Pix quando o comerciante completar essas pendências no
 * onboarding da Stripe.
 */
require("dotenv").config();
const pool = require("../db");
const { ensurePixCapability } = require("../services/stripeService");

(async () => {
  const { rows } = await pool.query(
    "SELECT id, name, stripe_account_id FROM companies WHERE stripe_account_id IS NOT NULL ORDER BY id",
  );
  console.log(`Contas conectadas encontradas: ${rows.length}`);

  for (const c of rows) {
    process.stdout.write(`- [${c.id}] ${c.name} (${c.stripe_account_id}) ... `);
    await ensurePixCapability(c.stripe_account_id);
    console.log("ok");
  }

  console.log("Backfill concluído.");
  await pool.end();
  process.exit(0);
})().catch((err) => {
  console.error("Falha no backfill:", err);
  process.exit(1);
});
