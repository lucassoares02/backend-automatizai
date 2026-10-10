const pool = require("../db");
const { tableExists } = require("../helpers/schema");
const bookingService = require("./bookingService");
const { normalizeIdList, normalizeWorkingHours, normalizeTimeOff } = require("../helpers/serviceItem");

// ─── Profissionais (quem executa os serviços do catálogo) ────────────────────
// CRUD escopado por company_id + serviços habilitados, jornada semanal e folgas.
// Tabelas da migration "Serviços com agendamento (Fase 1)" em DB_CHANGES_NEEDED.md.

const _unavailable = () =>
  Object.assign(new Error("Cadastro de profissionais ainda não habilitado: a migração do banco está pendente."), {
    status: 503,
  });

const ensureSchema = async () => {
  const checks = await Promise.all(
    ["professionals", "professional_services", "professional_working_hours", "professional_time_off"].map(tableExists),
  );
  if (!checks.every(Boolean)) throw _unavailable();
};

const _badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const _cleanText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
};

// Listagem com os serviços (nome/duração/override) e a jornada de cada um.
const _SELECT = `
  SELECT p.id, p.company_id, p.name, p.photo_url, p.bio, p.phone, p.active, p.user_id,
         p.created_at, p.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'menu_item_id', ps.menu_item_id,
                    'name', mi.name,
                    'duration_minutes', mi.duration_minutes,
                    'price', mi.price,
                    'price_override', ps.price_override,
                    'duration_override', ps.duration_override
                  ) ORDER BY mi.name)
           FROM professional_services ps
           JOIN menu_items mi ON mi.id = ps.menu_item_id AND mi.deleted_at IS NULL
           WHERE ps.professional_id = p.id
         ), '[]'::json) AS services,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', wh.id,
                    'weekday', wh.weekday,
                    'start_time', to_char(wh.start_time, 'HH24:MI'),
                    'end_time', to_char(wh.end_time, 'HH24:MI')
                  ) ORDER BY wh.weekday, wh.start_time)
           FROM professional_working_hours wh
           WHERE wh.professional_id = p.id
         ), '[]'::json) AS working_hours
  FROM professionals p`;

const findByCompany = async (companyId, { onlyActive = false } = {}) => {
  await ensureSchema();
  const activeFilter = onlyActive ? "AND p.active = TRUE" : "";
  const result = await pool.query(
    `${_SELECT} WHERE p.company_id = $1 ${activeFilter} ORDER BY p.active DESC, p.name ASC`,
    [companyId],
  );
  return result.rows;
};

const find = async (id) => {
  await ensureSchema();
  const result = await pool.query(`${_SELECT} WHERE p.id = $1`, [id]);
  return result.rows[0] || null;
};

// Vincula os serviços (somente itens do tipo serviço da mesma empresa),
// preservando preço/duração próprios de quem continua.
const _syncServices = async (client, professionalId, companyId, serviceIds) => {
  if (serviceIds === null) return;
  await client.query(
    "DELETE FROM professional_services WHERE professional_id = $1 AND NOT (menu_item_id = ANY($2::int[]))",
    [professionalId, serviceIds],
  );
  if (!serviceIds.length) return;
  await client.query(
    `INSERT INTO professional_services (professional_id, menu_item_id)
     SELECT $1, mi.id FROM menu_items mi
     WHERE mi.company_id = $2 AND mi.id = ANY($3::int[])
       AND mi.item_type = 'service' AND mi.deleted_at IS NULL
     ON CONFLICT (professional_id, menu_item_id) DO NOTHING`,
    [professionalId, companyId, serviceIds],
  );
};

const _replaceWorkingHours = async (client, professionalId, hours) => {
  if (hours === null) return;
  await client.query("DELETE FROM professional_working_hours WHERE professional_id = $1", [professionalId]);
  for (const h of hours) {
    await client.query(
      `INSERT INTO professional_working_hours (professional_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, $4)`,
      [professionalId, h.weekday, h.start_time, h.end_time],
    );
  }
};

const _withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const create = async (data) => {
  await ensureSchema();
  const name = _cleanText(data.name);
  if (!name) throw _badRequest("Informe o nome do profissional.");
  const serviceIds = normalizeIdList(data.service_ids);
  const hours = Array.isArray(data.working_hours) ? normalizeWorkingHours(data.working_hours) : null;

  const id = await _withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO professionals (company_id, name, photo_url, bio, phone, active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE))
       RETURNING id`,
      [
        data.company_id,
        name,
        _cleanText(data.photo_url) ?? null,
        _cleanText(data.bio) ?? null,
        _cleanText(data.phone) ?? null,
        typeof data.active === "boolean" ? data.active : null,
      ],
    );
    const newId = result.rows[0].id;
    await _syncServices(client, newId, data.company_id, serviceIds);
    await _replaceWorkingHours(client, newId, hours);
    return newId;
  });
  return find(id);
};

// Atualização parcial: só altera os campos enviados. service_ids e
// working_hours, quando presentes, substituem a lista inteira.
const update = async (id, data) => {
  await ensureSchema();
  const current = await pool.query("SELECT id, company_id FROM professionals WHERE id = $1", [id]);
  const row = current.rows[0];
  if (!row) return null;

  const sets = [];
  const vals = [id];
  const push = (col, value) => {
    vals.push(value);
    sets.push(`${col} = $${vals.length}`);
  };
  if (data.name !== undefined) {
    const name = _cleanText(data.name);
    if (!name) throw _badRequest("Informe o nome do profissional.");
    push("name", name);
  }
  for (const col of ["photo_url", "bio", "phone"]) {
    if (data[col] !== undefined) push(col, _cleanText(data[col]));
  }
  if (typeof data.active === "boolean") push("active", data.active);

  const serviceIds = normalizeIdList(data.service_ids);
  const hours = Array.isArray(data.working_hours) ? normalizeWorkingHours(data.working_hours) : null;

  await _withTransaction(async (client) => {
    sets.push("updated_at = NOW()");
    await client.query(`UPDATE professionals SET ${sets.join(", ")} WHERE id = $1`, vals);
    await _syncServices(client, row.id, row.company_id, serviceIds);
    await _replaceWorkingHours(client, row.id, hours);
  });
  return find(id);
};

// Remover apaga vínculos, jornada e folgas (ON DELETE CASCADE). Quando houver
// agendamentos (Fase 2), prefira desativar.
const remove = async (id) => {
  await ensureSchema();
  if (await bookingService.professionalHasAppointments(id)) {
    throw Object.assign(
      new Error("Este profissional tem agendamentos. Desative-o em vez de excluir."),
      { status: 409 },
    );
  }
  const result = await pool.query("DELETE FROM professionals WHERE id = $1 RETURNING *", [id]);
  return result.rows[0] || null;
};

// Preço/duração próprios do profissional para um serviço já vinculado.
const updateServiceOverride = async (professionalId, menuItemId, { price_override, duration_override }) => {
  await ensureSchema();
  const price = price_override === null || price_override === undefined || price_override === "" ? null : Number(price_override);
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw _badRequest("Preço inválido.");
  const duration =
    duration_override === null || duration_override === undefined || duration_override === ""
      ? null
      : Number(duration_override);
  if (duration !== null && (!Number.isInteger(duration) || duration < 5 || duration > 1440)) {
    throw _badRequest("Duração deve ficar entre 5 e 1440 minutos.");
  }
  const result = await pool.query(
    `UPDATE professional_services SET price_override = $3, duration_override = $4
     WHERE professional_id = $1 AND menu_item_id = $2 RETURNING *`,
    [professionalId, menuItemId, price, duration],
  );
  return result.rows[0] || null;
};

// ─── Folgas ──────────────────────────────────────────────────────────────────
const listTimeOff = async (professionalId, { includePast = false } = {}) => {
  await ensureSchema();
  const filter = includePast ? "" : "AND ends_at >= NOW()";
  const result = await pool.query(
    `SELECT id, professional_id, starts_at, ends_at, reason, created_at
     FROM professional_time_off
     WHERE professional_id = $1 ${filter}
     ORDER BY starts_at`,
    [professionalId],
  );
  return result.rows;
};

const addTimeOff = async (professionalId, data) => {
  await ensureSchema();
  const t = normalizeTimeOff(data);
  const result = await pool.query(
    `INSERT INTO professional_time_off (professional_id, starts_at, ends_at, reason)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [professionalId, t.startsAt, t.endsAt, t.reason],
  );
  return result.rows[0];
};

const removeTimeOff = async (professionalId, timeOffId) => {
  await ensureSchema();
  const result = await pool.query(
    "DELETE FROM professional_time_off WHERE id = $1 AND professional_id = $2 RETURNING *",
    [timeOffId, professionalId],
  );
  return result.rows[0] || null;
};

module.exports = {
  findByCompany,
  find,
  create,
  update,
  remove,
  updateServiceOverride,
  listTimeOff,
  addTimeOff,
  removeTimeOff,
};
