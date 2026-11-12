const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../services/passwordEmailService");
const { comparePassword } = require("../helpers/hash");

const user = { id: 7, name: "Ana", email: "ana@exemplo.com" };

const fakeDeps = (overrides = {}) => {
  const calls = { updates: [], sends: [] };
  const deps = {
    template: "<p>@name</p><p>@email</p><p>@password</p><a href=\"@link\">@link</a>",
    hash: async (p) => `hash:${p}`,
    updatePassword: async (id, hashed) => { calls.updates.push([id, hashed]); },
    send: async (from, to, subject, text, html) => { calls.sends.push({ to, subject, html }); return { messageId: "m1" }; },
    findUser: async (email) => (email === user.email ? user : null),
    cooldown: new Map(),
    now: 1_000_000,
    ...overrides,
  };
  return { deps, calls };
};

test("gera senhas fortes e diferentes", () => {
  const a = service.generatePassword();
  const b = service.generatePassword();
  assert.equal(a.length, 12);
  assert.match(a, /^[A-Za-z0-9]+$/);
  assert.notEqual(a, b);
});

test("grava a senha nova no usuário certo e envia a mesma senha", async () => {
  const { deps, calls } = fakeDeps({ hash: require("../helpers/hash").hashPassword });
  await service.resetAndSend(user, "access", deps);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0][0], 7);
  const sent = calls.sends[0];
  assert.equal(sent.to, user.email);
  assert.equal(sent.subject, service.KINDS.access.subject);
  const password = sent.html.match(/<p>([A-Za-z0-9]{12})<\/p>/)[1];
  assert.equal(await comparePassword(password, calls.updates[0][1]), true);
});

test("escapa os dados do usuário e não reaproveita placeholders vindos do nome", () => {
  const html = service.renderEmail({
    template: "@name|@password",
    name: "<b>@password</b>",
    email: "x",
    password: "SECRET",
    link: "",
  });
  assert.equal(html, "&lt;b&gt;@password&lt;/b&gt;|SECRET");
});

test("esqueci a senha: e-mail inexistente não troca nada", async () => {
  const { deps, calls } = fakeDeps();
  const out = await service.requestForgotPassword("nao@existe.com", deps);
  assert.equal(out.sent, false);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.sends.length, 0);
});

test("esqueci a senha: normaliza o e-mail e troca a senha do usuário encontrado", async () => {
  const { deps, calls } = fakeDeps();
  const out = await service.requestForgotPassword("  ANA@Exemplo.com ", deps);
  assert.equal(out.sent, true);
  assert.equal(calls.updates[0][0], 7);
  assert.equal(calls.sends[0].subject, service.KINDS.forgot.subject);
});

test("esqueci a senha: segundo pedido dentro do intervalo é ignorado", async () => {
  const { deps, calls } = fakeDeps();
  await service.requestForgotPassword(user.email, deps);
  const second = await service.requestForgotPassword(user.email, { ...deps, now: deps.now + 1000 });
  assert.equal(second.reason, "cooldown");
  const later = await service.requestForgotPassword(user.email, { ...deps, now: deps.now + service.FORGOT_COOLDOWN_MS });
  assert.equal(later.sent, true);
  assert.equal(calls.updates.length, 2);
});

test("controller público ignora id/html do corpo e responde sempre igual", async () => {
  const controller = require("../controllers/maillerController");
  const original = service.requestForgotPassword;
  const seen = [];
  service.requestForgotPassword = async (email) => { seen.push(email); return { sent: false }; };
  try {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await controller.sendEmail({ body: { email: "Ana@Exemplo.com", id: 1, html: "<evil>" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, ["ana@exemplo.com"]);

    const bad = { statusCode: null };
    bad.status = (c) => { bad.statusCode = c; return bad; };
    bad.json = () => bad;
    await controller.sendEmail({ body: { id: 1 } }, bad);
    assert.equal(bad.statusCode, 400);
  } finally {
    service.requestForgotPassword = original;
  }
});
