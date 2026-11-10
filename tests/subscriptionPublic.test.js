const test = require("node:test");
const assert = require("node:assert/strict");
const { publicSubscriptionPlan, subscriptionsReleased } = require("../helpers/subscriptionItem");

const row = (extra = {}) => ({
  id: "12",
  name: "Clube do café",
  description: "1 kg por mês",
  price: "89.90",
  image_url: null,
  images: ["https://x/1.jpg"],
  item_type: "product",
  has_options: false,
  subscription_interval: "month",
  subscription_duration_cycles: 12,
  subscription_usage_limit: 3,
  ...extra,
});

test("vitrine: produto devolve o plano sem limite de uso", () => {
  const plan = publicSubscriptionPlan(row());
  assert.deepEqual(plan, {
    id: 12,
    name: "Clube do café",
    description: "1 kg por mês",
    price: 89.9,
    image_url: null,
    images: ["https://x/1.jpg"],
    item_type: "product",
    has_options: false,
    interval: "month",
    duration_cycles: 12,
    usage_limit: null,
  });
});

test("vitrine: serviço mantém o limite de usos; sem prazo vira null", () => {
  const plan = publicSubscriptionPlan(row({ item_type: "service", subscription_duration_cycles: null }));
  assert.equal(plan.item_type, "service");
  assert.equal(plan.usage_limit, 3);
  assert.equal(plan.duration_cycles, null);
});

test("vitrine: serviço ilimitado devolve usage_limit null", () => {
  const plan = publicSubscriptionPlan(row({ item_type: "service", subscription_usage_limit: null }));
  assert.equal(plan.usage_limit, null);
});

test("vitrine: plano incompleto fica de fora", () => {
  assert.equal(publicSubscriptionPlan(row({ subscription_interval: null })), null);
  assert.equal(publicSubscriptionPlan(row({ subscription_interval: "day" })), null);
  assert.equal(publicSubscriptionPlan(row({ price: 0 })), null);
  assert.equal(publicSubscriptionPlan(null), null);
});

test("vitrine: só aparece com SUBSCRIPTIONS_RELEASED=true", () => {
  const previous = process.env.SUBSCRIPTIONS_RELEASED;
  try {
    delete process.env.SUBSCRIPTIONS_RELEASED;
    assert.equal(subscriptionsReleased(), false);
    process.env.SUBSCRIPTIONS_RELEASED = "TRUE";
    assert.equal(subscriptionsReleased(), true);
    process.env.SUBSCRIPTIONS_RELEASED = "false";
    assert.equal(subscriptionsReleased(), false);
  } finally {
    if (previous === undefined) delete process.env.SUBSCRIPTIONS_RELEASED;
    else process.env.SUBSCRIPTIONS_RELEASED = previous;
  }
});
