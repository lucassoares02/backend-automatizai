const MAX_PREORDER_LEAD_DAYS = 365;
const BUSINESS_TIME_ZONE = "America/Sao_Paulo";

const normalizePreorder = ({ preorder_only, preorder_lead_days }) => {
  const preorderOnly = preorder_only === true;
  if (!preorderOnly) {
    return { preorderOnly: false, preorderLeadDays: null };
  }

  const leadDays = Number(preorder_lead_days);
  if (
    !Number.isInteger(leadDays) ||
    leadDays < 1 ||
    leadDays > MAX_PREORDER_LEAD_DAYS
  ) {
    throw Object.assign(
      new Error(
        `A antecedência da encomenda deve ser um número inteiro entre 1 e ${MAX_PREORDER_LEAD_DAYS} dias.`,
      ),
      { status: 400 },
    );
  }

  return { preorderOnly: true, preorderLeadDays: leadDays };
};

const inclusiveLeadDayOffset = (leadDays) =>
  Math.max(0, Number(leadDays || 1) - 1);

const _calendarDaySerial = (value, timeZone = BUSINESS_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick("year"), pick("month") - 1, pick("day")) / 86400000;
};

const meetsInclusiveLeadDays = ({
  orderedAt,
  scheduledAt,
  leadDays,
  timeZone = BUSINESS_TIME_ZONE,
}) => {
  const requiredOffset = inclusiveLeadDayOffset(leadDays);
  return (
    _calendarDaySerial(scheduledAt, timeZone) -
      _calendarDaySerial(orderedAt, timeZone) >=
    requiredOffset
  );
};

module.exports = {
  BUSINESS_TIME_ZONE,
  MAX_PREORDER_LEAD_DAYS,
  inclusiveLeadDayOffset,
  meetsInclusiveLeadDays,
  normalizePreorder,
};
