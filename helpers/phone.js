// Normalização canônica de telefone BR — ESPELHO EXATO da função SQL
// `normalize_phone` registrada em DB_CHANGES_NEEDED.md (FASE A.7).
//
// Regra: E.164 sem o '+': 55 + DDD + número.
//   - 10 ou 11 dígitos (DDD + fixo/celular)      -> prefixa '55'
//   - 12 ou 13 dígitos já iniciados por '55'      -> mantém
//   - qualquer outra coisa                        -> null (inválido)
//
// Um cliente com telefone "27998219176" e outro "5527998219176" DEVEM resolver
// para a mesma identidade — por isso a canonização força o 55. Nunca replicar
// esta lógica em outro lugar: importar daqui (e no SQL, usar normalize_phone).
const normalizePhone = (raw) => {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return "55" + digits;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return digits;
  return null;
};

module.exports = { normalizePhone };
