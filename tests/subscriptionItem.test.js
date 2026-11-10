const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const menuItemsService = require("../services/menu_itemsService");
const {
  canManageSubscriptions,
  normalizeSubscriptionFields,
  notSubscriptionSql,
} = require("../helpers/subscriptionItem");

const COMPANY = 7;
const ITEM = 55;

// Banco simulado: todas as colunas/tabelas existem, a categoria é da empresa e
// o INSERT/UPDATE devolve o que recebeu. `writes` guarda o SQL de escrita.
// `pagarmeActive` = recebedor Pagar.me ativo (Pix + cartão habilitados).
const withFakeDb = async ({ currentSubscription = false, pagarmeActive = true } = {}, fn) => {
  const writes = [];
  const handle = async (sql, params = []) => {
    if (sql.includes("information_schema.columns")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("FROM companies")) {
      return {
        rows: [{
          id: params[0],
          pagarme_recipient_id: pagarmeActive ? "rp_loja" : null,
          pagarme_charges_enabled: pagarmeActive,
          pagarme_recipient_status: pagarmeActive ? "active" : null,
        }],
      };
    }
    if (sql.startsWith("SELECT company_id, subscription_enabled")) {
      return { rows: [{ company_id: COMPANY, subscription_enabled: currentSubscription }] };
    }
    if (sql.includes("to_regclass")) return { rows: [{ name: "x" }] };
    if (sql.includes("FROM menu_categories")) return { rows: [{ id: params[0][0], company_id: COMPANY }] };
    if (sql.startsWith("SELECT subscription_enabled")) {
      return { rows: [{ subscription_enabled: currentSubscription }] };
    }
    if (sql.startsWith("SELECT item_type")) return { rows: [{ item_type: "product" }] };
    if (sql.includes("INSERT INTO menu_items") || sql.includes("UPDATE menu_items")) {
      writes.push({ sql, params });
      return { rows: [{ id: ITEM, company_id: COMPANY }] };
    }
    return { rows: [] };
  };
  const original = { query: pool.query, connect: pool.connect };
  pool.query = handle;
  pool.connect = async () => ({ query: handle, release: () => {} });
  try {
    await fn(writes);
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
  }
};

const base = (extra = {}) => ({
  company_id: COMPANY,
  category_id: 3,
  name: "Marmita semanal",
  description: "Uma marmita por semana",
  price: 49.9,
  available: true,
  ...extra,
});

const writtenColumns = (write) => {
  const insert = write.sql.match(/INSERT INTO menu_items \(([^)]+)\)/);
  if (insert) {
    const cols = insert[1].split(", ");
    return Object.fromEntries(cols.map((c, i) => [c, write.params[i]]));
  }
  const sets = [...write.sql.matchAll(/(\w+) = \$(\d+)/g)];
  return Object.fromEntries(sets.map(([, col, n]) => [col, write.params[Number(n) - 1]]));
};

test("só admin do sistema cadastra assinaturas, salvo liberação geral", () => {
  const previous = process.env.SUBSCRIPTIONS_RELEASED;
  try {
    delete process.env.SUBSCRIPTIONS_RELEASED;
    assert.equal(canManageSubscriptions({ isSystemAdmin: true }), true);
    assert.equal(canManageSubscriptions({ isSystemAdmin: false }), false);
    assert.equal(canManageSubscriptions({ isService: true, isSystemAdmin: false }), false);
    process.env.SUBSCRIPTIONS_RELEASED = "true";
    assert.equal(canManageSubscriptions({ isSystemAdmin: false }), true);
  } finally {
    if (previous === undefined) delete process.env.SUBSCRIPTIONS_RELEASED;
    else process.env.SUBSCRIPTIONS_RELEASED = previous;
  }
});

test("assinatura desligada zera a configuração", () => {
  assert.deepEqual(
    normalizeSubscriptionFields({ subscription_enabled: false, subscription_interval: "month", subscription_usage_limit: 3 }),
    { enabled: false, interval: null, durationCycles: null, usageLimit: null },
  );
});

test("valida frequência, preço, prazo e limite de usos", () => {
  const ok = { subscription_enabled: true, subscription_interval: "month", price: 100 };
  assert.deepEqual(normalizeSubscriptionFields(ok), {
    enabled: true, interval: "month", durationCycles: null, usageLimit: null,
  });
  assert.deepEqual(
    normalizeSubscriptionFields({ ...ok, subscription_duration_cycles: "12", subscription_usage_limit: 3 }, { isService: true }),
    { enabled: true, interval: "month", durationCycles: 12, usageLimit: 3 },
  );
  // Limite de usos só vale para serviço.
  assert.equal(normalizeSubscriptionFields({ ...ok, subscription_usage_limit: 3 }).usageLimit, null);

  const bad = [
    { ...ok, subscription_interval: "day" },
    { ...ok, price: 0 },
    { ...ok, subscription_duration_cycles: 0 },
    { ...ok, subscription_duration_cycles: 1.5 },
    { ...ok, subscription_duration_cycles: 121 },
  ];
  for (const data of bad) {
    assert.throws(() => normalizeSubscriptionFields(data), (e) => e.status === 400);
  }
  assert.throws(
    () => normalizeSubscriptionFields({ ...ok, subscription_usage_limit: 0 }, { isService: true }),
    (e) => e.status === 400,
  );
});

test("filtro SQL tira itens de assinatura das vendas avulsas", () => {
  assert.equal(notSubscriptionSql("mi"), "AND COALESCE(mi.subscription_enabled, false) = false");
  assert.equal(notSubscriptionSql(), "AND COALESCE(subscription_enabled, false) = false");
});

test("comerciante sem permissão não cria item de assinatura", async () => {
  await withFakeDb({}, async (writes) => {
    await assert.rejects(
      menuItemsService.create(base({ subscription_enabled: true, subscription_interval: "month" })),
      (e) => e.status === 403,
    );
    assert.equal(writes.length, 0);
  });
});

test("admin cria item de assinatura com a configuração normalizada", async () => {
  await withFakeDb({}, async (writes) => {
    await menuItemsService.create(
      base({ subscription_enabled: true, subscription_interval: "month", subscription_duration_cycles: 12 }),
      { allowSubscriptions: true },
    );
    const cols = writtenColumns(writes[0]);
    assert.equal(cols.subscription_enabled, true);
    assert.equal(cols.subscription_interval, "month");
    assert.equal(cols.subscription_duration_cycles, 12);
    assert.equal(cols.subscription_usage_limit, null);
  });
});

test("comerciante sem permissão edita item de assinatura sem mexer no plano", async () => {
  await withFakeDb({ currentSubscription: true }, async (writes) => {
    await menuItemsService.update(
      base({ id: ITEM, name: "Novo nome", subscription_enabled: false, subscription_interval: null }),
    );
    const cols = writtenColumns(writes[0]);
    assert.equal(cols.name, "Novo nome");
    assert.equal("subscription_enabled" in cols, false);
  });
});

test("comerciante sem permissão não liga a assinatura de um item avulso", async () => {
  await withFakeDb({ currentSubscription: false }, async (writes) => {
    await assert.rejects(
      menuItemsService.update(base({ id: ITEM, subscription_enabled: true, subscription_interval: "month" })),
      (e) => e.status === 403,
    );
    assert.equal(writes.length, 0);
  });
});

test("loja sem Pix e cartão na Pagar.me não cria item de assinatura", async () => {
  await withFakeDb({ pagarmeActive: false }, async (writes) => {
    await assert.rejects(
      menuItemsService.create(
        base({ subscription_enabled: true, subscription_interval: "month" }),
        { allowSubscriptions: true },
      ),
      (e) => e.status === 409 && e.code === "subscription_payments_disabled",
    );
    assert.equal(writes.length, 0);
  });
});

test("loja sem Pix e cartão na Pagar.me continua criando itens avulsos", async () => {
  await withFakeDb({ pagarmeActive: false }, async (writes) => {
    await menuItemsService.create(base({ subscription_enabled: false }), { allowSubscriptions: true });
    assert.equal(writtenColumns(writes[0]).subscription_enabled, false);
  });
});

test("loja sem Pix e cartão na Pagar.me não transforma item avulso em assinatura", async () => {
  await withFakeDb({ pagarmeActive: false, currentSubscription: false }, async (writes) => {
    await assert.rejects(
      menuItemsService.update(
        base({ id: ITEM, subscription_enabled: true, subscription_interval: "month" }),
        { allowSubscriptions: true },
      ),
      (e) => e.status === 409,
    );
    assert.equal(writes.length, 0);
  });
});

test("item que já é assinatura segue editável sem nova checagem da Pagar.me", async () => {
  await withFakeDb({ pagarmeActive: false, currentSubscription: true }, async (writes) => {
    await menuItemsService.update(
      base({ id: ITEM, name: "Novo nome", subscription_enabled: true, subscription_interval: "week" }),
      { allowSubscriptions: true },
    );
    const cols = writtenColumns(writes[0]);
    assert.equal(cols.name, "Novo nome");
    assert.equal(cols.subscription_interval, "week");
  });
});

test("loja sem Pix e cartão na Pagar.me não duplica item de assinatura", async () => {
  await withFakeDb({ pagarmeActive: false, currentSubscription: true }, async (writes) => {
    await assert.rejects(
      menuItemsService.duplicate(ITEM, { allowSubscriptions: true }),
      (e) => e.status === 409,
    );
    assert.equal(writes.length, 0);
  });
});
