const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = "customer-auth-test-secret";

const { generateToken } = require("../helpers/jwt");
const {
  customerAuth,
  optionalCustomerAuth,
} = require("../src/middlewares/customerAuth");

const responseRecorder = () => {
  const state = { status: null, body: null };
  return {
    state,
    status(code) {
      state.status = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
};

test("aceita apenas JWT com escopo exclusivo de consumidor", () => {
  const token = generateToken({
    id: "a9778bc7-4f85-4b37-9f67-e1e7e2d68621",
    email: "cliente@example.com",
    scope: "customer",
    aud: "customer",
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();
  let called = false;

  customerAuth(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(req.customer.email, "cliente@example.com");
  assert.equal(res.state.status, null);
});

test("não aceita JWT administrativo na área do consumidor", () => {
  const token = generateToken({ id: 9, email: "admin@example.com" });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = responseRecorder();
  let called = false;

  customerAuth(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.state.status, 401);
});

test("autenticação opcional não bloqueia o checkout anônimo", () => {
  const req = { headers: { authorization: "Bearer inválido" } };
  let called = false;

  optionalCustomerAuth(req, {}, () => { called = true; });

  assert.equal(called, true);
  assert.equal(req.customer, null);
});
