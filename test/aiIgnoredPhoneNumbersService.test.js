const test = require("node:test");
const assert = require("node:assert/strict");
const { _testing } = require("../services/aiIgnoredPhoneNumbersService");

test("normaliza celular nacional e JID da Evolution para o mesmo telefone", () => {
  assert.equal(_testing.normalizeBrazilianPhone("(27) 9 9821-9176"), "5527998219176");
  assert.equal(_testing.normalizeBrazilianPhone("5527998219176@s.whatsapp.net"), "5527998219176");
});

test("extrai remoteJidAlt quando a conversa chega identificada por @lid", () => {
  const phones = _testing.extractSenderPhones({
    data: {
      key: {
        remoteJid: "123456789012345@lid",
        remoteJidAlt: "5527998219176@s.whatsapp.net",
      },
    },
  });
  assert.deepEqual(phones, ["5527998219176"]);
});

test("rejeita telefone que não representa celular brasileiro completo", () => {
  assert.throws(
    () => _testing.validateMobilePhone("55 (27) 3 3222-1111"),
    /formato 55 \(DDD\) 9 0000-0000/,
  );
});
