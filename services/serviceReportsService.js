// Relatório de serviços com agendamento (Fase 3): receita por profissional,
// taxa de ocupação, no-show e serviços mais vendidos num período de datas
// locais (fuso da empresa). Base: `appointments` (1 por pedido de serviço).
//
// - Receita = total do pedido sem a taxa de serviço da plataforma, só de
//   atendimentos concluídos.
// - Ocupação = minutos agendados (ativos + concluídos + no-show, que também
//   seguraram a agenda) ÷ minutos de jornada aberta (jornada ∩ loja − folgas).
// - No-show = não compareceu ÷ (concluídos + não compareceu).

const pool = require("../db");
const bookingService = require("./bookingService");
const { tableExists } = require("../helpers/schema");
const slots = require("../helpers/bookingSlots");
const { availableMinutes, rate } = require("../helpers/appointmentMetrics");

const OCCUPYING = ["hold", "confirmed", "in_progress", "done", "no_show"];

const getServicesReport = async (companyId, from, to) => {
  if (!(await bookingService.hasBookingSchema())) return { enabled: false };
  const company = await bookingService.loadCompanySettings(companyId);
  if (!company) return null;
  const tz = company.timezone;
  const rangeStart = slots.zonedTimeToUtc(from, 0, tz);
  const rangeEnd = slots.zonedTimeToUtc(slots.addDays(to, 1), 0, tz);
  const hasTimeOff = await tableExists("professional_time_off");

  const [apptRes, profRes, hoursRes, offRes, openingRes] = await Promise.all([
    pool.query(
      `SELECT a.id, a.status, a.professional_id, a.menu_item_id, a.starts_at, a.ends_at,
              mi.name AS service_name,
              GREATEST(COALESCE(o.total, 0) - COALESCE(o.service_fee, 0), 0)::float AS revenue
       FROM appointments a
       JOIN orders o ON o.id = a.order_id
       LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
       WHERE a.company_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3`,
      [company.id, rangeStart, rangeEnd],
    ),
    pool.query("SELECT id, name, photo_url, active FROM professionals WHERE company_id = $1 ORDER BY name", [
      company.id,
    ]),
    pool.query(
      `SELECT wh.professional_id, wh.weekday, wh.start_time::text AS start_time, wh.end_time::text AS end_time
       FROM professional_working_hours wh JOIN professionals p ON p.id = wh.professional_id
       WHERE p.company_id = $1`,
      [company.id],
    ),
    hasTimeOff
      ? pool.query(
          `SELECT t.professional_id, t.starts_at, t.ends_at
           FROM professional_time_off t JOIN professionals p ON p.id = t.professional_id
           WHERE p.company_id = $1 AND t.starts_at < $3 AND t.ends_at > $2`,
          [company.id, rangeStart, rangeEnd],
        )
      : { rows: [] },
    pool.query(
      "SELECT weekday, opens_at::text AS opens_at, closes_at::text AS closes_at, is_closed FROM company_opening_hours WHERE company_id = $1",
      [company.id],
    ),
  ]);

  const group = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const k = Number(r.professional_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  };
  const hours = group(hoursRes.rows);
  const off = group(offRes.rows);
  const appts = apptRes.rows;
  const minutesOf = (a) => Math.max(0, (new Date(a.ends_at) - new Date(a.starts_at)) / 60000);

  const byProfessional = profRes.rows
    .map((p) => {
      const mine = appts.filter((a) => Number(a.professional_id) === Number(p.id));
      const done = mine.filter((a) => a.status === "done");
      const noShow = mine.filter((a) => a.status === "no_show").length;
      const booked = Math.round(
        mine.filter((a) => OCCUPYING.includes(a.status)).reduce((sum, a) => sum + minutesOf(a), 0),
      );
      const available = availableMinutes({
        fromDate: from,
        toDate: to,
        timezone: tz,
        workingHours: hours.get(Number(p.id)) || [],
        openingHours: openingRes.rows,
        timeOff: off.get(Number(p.id)) || [],
      });
      return {
        id: Number(p.id),
        name: p.name,
        photo_url: p.photo_url,
        active: p.active === true,
        appointments: mine.filter((a) => a.status !== "cancelled").length,
        done: done.length,
        no_show: noShow,
        cancelled: mine.filter((a) => a.status === "cancelled").length,
        revenue: Number(done.reduce((sum, a) => sum + Number(a.revenue), 0).toFixed(2)),
        booked_minutes: booked,
        available_minutes: available,
        occupancy_rate: rate(Math.min(booked, available || booked), available),
        no_show_rate: rate(noShow, done.length + noShow),
      };
    })
    .filter((p) => p.active || p.appointments > 0 || p.cancelled > 0)
    .sort((a, b) => b.revenue - a.revenue || b.appointments - a.appointments);

  const services = new Map();
  for (const a of appts) {
    if (a.status === "cancelled") continue;
    const key = a.menu_item_id != null ? Number(a.menu_item_id) : 0;
    if (!services.has(key)) {
      services.set(key, { menu_item_id: key || null, name: a.service_name || "Serviço removido", count: 0, done: 0, revenue: 0 });
    }
    const s = services.get(key);
    s.count++;
    if (a.status === "done") {
      s.done++;
      s.revenue += Number(a.revenue);
    }
  }
  const topServices = [...services.values()]
    .map((s) => ({ ...s, revenue: Number(s.revenue.toFixed(2)) }))
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
    .slice(0, 10);

  const done = appts.filter((a) => a.status === "done").length;
  const noShow = appts.filter((a) => a.status === "no_show").length;
  const booked = byProfessional.reduce((sum, p) => sum + p.booked_minutes, 0);
  const available = byProfessional.reduce((sum, p) => sum + p.available_minutes, 0);
  return {
    enabled: true,
    range: { from, to },
    timezone: tz,
    summary: {
      appointments: appts.filter((a) => a.status !== "cancelled").length,
      done,
      no_show: noShow,
      cancelled: appts.filter((a) => a.status === "cancelled").length,
      upcoming: appts.filter((a) => ["hold", "confirmed", "in_progress"].includes(a.status)).length,
      revenue: Number(byProfessional.reduce((sum, p) => sum + p.revenue, 0).toFixed(2)),
      avg_ticket: done ? Number((byProfessional.reduce((sum, p) => sum + p.revenue, 0) / done).toFixed(2)) : 0,
      booked_minutes: booked,
      available_minutes: available,
      occupancy_rate: rate(Math.min(booked, available || booked), available),
      no_show_rate: rate(noShow, done + noShow),
    },
    by_professional: byProfessional,
    top_services: topServices,
  };
};

module.exports = { getServicesReport };
