const test = require("node:test");
const assert = require("node:assert/strict");
const { formatAppointmentDate, renderServiceMessage } = require("../services/orderWebhookService");
const notifications = require("../services/orderStatusNotificationService");

test("data e hora do agendamento saem no fuso da empresa", () => {
  // 2026-10-09 é sexta; 17:30Z = 14:30 em São Paulo.
  assert.deepEqual(formatAppointmentDate("2026-10-09T17:30:00Z", "America/Sao_Paulo"), {
    date: "sex, 09/10",
    time: "14:30",
  });
});

test("placeholders de serviço são substituídos", () => {
  const text = renderServiceMessage(notifications.SERVICE_DEFAULT_MESSAGES[102], {
    cliente: "Ana",
    servico: "Corte",
    profissional: "Bia",
    data: "sex, 09/10",
    hora: "14:30",
    loja: "Studio",
  });
  assert.equal(text, "Olá Ana! Seu horário de Corte com Bia está confirmado para sex, 09/10 às 14:30. Te esperamos na Studio! 📅");
});

test("eventos de serviço têm mensagem padrão e não colidem com status de pedido", () => {
  for (const id of notifications.SERVICE_NOTIFIABLE) {
    assert.ok(notifications.SERVICE_DEFAULT_MESSAGES[id], `sem mensagem para ${id}`);
    assert.ok(!notifications.NOTIFIABLE_STATUSES.includes(id));
  }
});
