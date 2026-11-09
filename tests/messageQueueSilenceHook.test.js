const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const evolution = require("../services/evolutionService");
const connectionsService = require("../services/connectionsService");
const aiIgnoredPhoneNumbersService = require("../services/aiIgnoredPhoneNumbersService");
const { enqueue } = require("../services/messageQueueService");

const silenceHookBody = (overrides = {}) => ({
  event: "messages.upsert",
  instance: "loja-a",
  data: {
    key: { id: "HOOK_1_1", fromMe: false, remoteJid: "5527992886969@s.whatsapp.net" },
    source: "silence_hook",
    message: { conversation: "[EVENTO_SISTEMA: retomada_carrinho]" },
    messageType: "conversation",
    ...overrides,
  },
  silence_hook: { job_id: "1", hook_type: "cart_abandoned" },
});

const setup = (t, { ignored = false, conn = { company_id: 24, ai_enabled: true } } = {}) => {
  const forwarded = [];
  t.mock.method(evolution, "forwardToN8n", async (instance, payload) => forwarded.push({ instance, payload }));
  t.mock.method(connectionsService, "find_by_instance", async () => conn);
  t.mock.method(aiIgnoredPhoneNumbersService, "shouldIgnoreMessage", async () => ignored);
  const connect = t.mock.method(pool, "connect", async () => {
    throw new Error("não deveria usar a fila");
  });
  return { forwarded, connect };
};

test("silence hook vai direto ao n8n sem passar pela fila", async (t) => {
  const { forwarded, connect } = setup(t);
  await enqueue("loja-a", silenceHookBody());

  assert.equal(connect.mock.callCount(), 0);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].instance, "loja-a");
  const { payload } = forwarded[0];
  assert.equal(payload.data.source, "silence_hook");
  assert.deepEqual(payload.silence_hook, { job_id: "1", hook_type: "cart_abandoned" });
  assert.equal(payload.ai_enabled, true);
  assert.equal(payload._queue.immediate, true);
  assert.equal(payload._queue.direction, "system");
  assert.equal(payload._queue.id, undefined);
  assert.equal(payload._queue.aggregated_text, "[EVENTO_SISTEMA: retomada_carrinho]");
});

test("silence hook repetido (mesmo key.id) é enviado de novo", async (t) => {
  const { forwarded } = setup(t);
  await enqueue("loja-a", silenceHookBody());
  await enqueue("loja-a", silenceHookBody());
  assert.equal(forwarded.length, 2);
});

test("silence hook envia o estado da IA da conexão", async (t) => {
  const { forwarded } = setup(t, { conn: { company_id: 24, ai_enabled: false } });
  await enqueue("loja-a", silenceHookBody());
  assert.equal(forwarded[0].payload.ai_enabled, false);
  assert.equal(forwarded[0].payload._queue.ai_enabled, false);
});

test("silence hook para contato ignorado não é enviado", async (t) => {
  const { forwarded, connect } = setup(t, { ignored: true });
  await enqueue("loja-a", silenceHookBody());
  assert.equal(forwarded.length, 0);
  assert.equal(connect.mock.callCount(), 0);
});

test("mensagem comum continua indo para a fila", async (t) => {
  const { forwarded, connect } = setup(t);
  await assert.rejects(enqueue("loja-a", silenceHookBody({ source: "android" })), /não deveria usar a fila/);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(forwarded.length, 0);
});
