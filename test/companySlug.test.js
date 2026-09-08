const test = require("node:test");
const assert = require("node:assert/strict");
const {
  companySlugCandidate,
  insertWithUniqueCompanySlug,
  slugifyCompanyName,
} = require("../helpers/companySlug");

test("gera slug de empresa sem acentos nem caracteres especiais", () => {
  assert.equal(slugifyCompanyName("Espeto do Flávio"), "espeto-do-flavio");
  assert.equal(
    slugifyCompanyName("  Café & Cifrão R$  "),
    "cafe-cifrao-r",
  );
});

test("gera sufixos incrementais para nomes duplicados", () => {
  const base = slugifyCompanyName("Espeto do Flávio");
  assert.equal(companySlugCandidate(base, 0), "espeto-do-flavio");
  assert.equal(companySlugCandidate(base, 1), "espeto-do-flavio-1");
  assert.equal(companySlugCandidate(base, 2), "espeto-do-flavio-2");
});

test("evita ambiguidade com ids e UUIDs usados pelos links antigos", () => {
  assert.equal(slugifyCompanyName("123"), "empresa-123");
  assert.equal(
    slugifyCompanyName("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    "empresa-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
});

test("usa fallback quando o nome não contém caracteres válidos", () => {
  assert.equal(slugifyCompanyName("💰 $$$"), "empresa");
});

test("reserva o próximo sufixo livre no banco", async () => {
  const occupied = new Set(["espeto-do-flavio", "espeto-do-flavio-1"]);
  const db = {
    query: async (_sql, [slug]) => ({
      rows: occupied.has(slug) ? [{ exists: true }] : [],
    }),
  };

  const result = await insertWithUniqueCompanySlug({
    db,
    name: "Espeto do Flávio",
    insert: async (slug) => ({ rows: [{ slug }] }),
  });

  assert.equal(result.rows[0].slug, "espeto-do-flavio-2");
});
