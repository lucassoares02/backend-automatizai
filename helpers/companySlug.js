const MAX_COMPANY_SLUG_LENGTH = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const slugifyCompanyName = (value) => {
  let slug = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) slug = "empresa";
  // O mesmo segmento da URL ainda aceita id e UUID por compatibilidade. Evita
  // gerar um slug que possa ser interpretado como uma dessas referências.
  if (/^\d+$/.test(slug) || UUID_RE.test(slug)) {
    slug = `empresa-${slug}`;
  }
  return slug.slice(0, MAX_COMPANY_SLUG_LENGTH).replace(/-+$/g, "");
};

const companySlugCandidate = (baseSlug, suffix = 0) => {
  if (suffix <= 0) return baseSlug;
  const ending = `-${suffix}`;
  const baseLimit = MAX_COMPANY_SLUG_LENGTH - ending.length;
  const trimmedBase = baseSlug.slice(0, baseLimit).replace(/-+$/g, "");
  return `${trimmedBase}${ending}`;
};

const isCompanySlugConflict = (error) =>
  error?.code === "23505" &&
  (/slug/i.test(String(error.constraint ?? "")) ||
    /\(slug\)/i.test(String(error.detail ?? "")));

/**
 * Insere uma empresa reservando um slug legível. A consulta prévia resolve as
 * colisões normais; o retry da violação UNIQUE cobre duas criações simultâneas.
 */
const insertWithUniqueCompanySlug = async ({ db, name, insert }) => {
  const baseSlug = slugifyCompanyName(name);
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const slug = companySlugCandidate(baseSlug, suffix);
    const existing = await db.query(
      "SELECT 1 FROM companies WHERE slug = $1 LIMIT 1",
      [slug],
    );
    if (existing.rows.length > 0) continue;
    try {
      return await insert(slug);
    } catch (error) {
      if (isCompanySlugConflict(error)) continue;
      throw error;
    }
  }
  throw Object.assign(
    new Error("Não foi possível gerar um endereço único para esta empresa."),
    { status: 409 },
  );
};

module.exports = {
  MAX_COMPANY_SLUG_LENGTH,
  UUID_RE,
  companySlugCandidate,
  insertWithUniqueCompanySlug,
  isCompanySlugConflict,
  slugifyCompanyName,
};
