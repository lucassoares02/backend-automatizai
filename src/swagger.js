// Documentação OpenAPI (Swagger) da API.
//
// A especificação é GERADA por introspecção do router Express (src/routes.js),
// então cobre automaticamente todas as rotas e nunca fica dessincronizada. Cada
// rota vira uma operação, agrupada por recurso (primeiro segmento do path), com:
//   - segurança inferida (JWT Bearer ou API Key de serviço) quando a rota usa o
//     `authMiddleware`; rotas públicas ficam sem `security`;
//   - parâmetros de path (`:id` → `{id}`);
//   - resumo legível derivado do método + recurso.
//
// Para enriquecer um endpoint específico (descrição, corpo, exemplos), adicione
// uma entrada em OVERRIDES abaixo, chaveada por "MÉTODO /api/caminho".

const swaggerUi = require("swagger-ui-express");
const router = require("./routes");

// Nomes amigáveis por segmento inicial do path (vira a tag/agrupamento no UI).
const TAG_META = {
  root: { name: "Health", description: "Status da API" },
  signin: { name: "Auth", description: "Autenticação e sessão" },
  auth: { name: "Auth", description: "Autenticação e sessão" },
  users: { name: "Users", description: "Usuários da plataforma" },
  "send-email": { name: "Mail", description: "Envio de e-mail" },
  register: { name: "Register", description: "Cadastro pré-login" },
  companies: { name: "Companies", description: "Empresa (identidade e marca)" },
  companiessss: { name: "Companies", description: "Empresa (CRUD completo)" },
  account: { name: "Account", description: "Conta do usuário logado" },
  cnpj: { name: "Register", description: "Consulta de CNPJ" },
  company_opening_hours: { name: "Opening Hours", description: "Horários de funcionamento" },
  menu_categories: { name: "Menu Categories", description: "Categorias do cardápio" },
  menu_items: { name: "Menu Items", description: "Itens do cardápio" },
  company: { name: "Company Address", description: "Endereço da empresa" },
  payment_methods: { name: "Payment Methods", description: "Formas de pagamento" },
  connections: { name: "Connections", description: "Conexões WhatsApp (Evolution)" },
  additional_info: { name: "Additional Info", description: "Informações adicionais" },
  clients: { name: "Clients", description: "Clientes da empresa" },
  orders: { name: "Orders", description: "Pedidos" },
  deliveries: { name: "Deliveries", description: "Gestão de entregas / rotas" },
  "delivery-drivers": { name: "Delivery Drivers", description: "Motoboys" },
  dashboard: { name: "Dashboard", description: "Visão executiva agregada" },
  promotions: { name: "Promotions", description: "Promoções / combos" },
  campaigns: { name: "Campaigns", description: "Campanhas de marketing (IA/n8n)" },
  upsell: { name: "Upsell", description: "Regras de upsell" },
  "search-analytics": { name: "Search Analytics", description: "Analytics de busca" },
  address: { name: "Address", description: "Google Places (autocomplete/detalhes)" },
  "product-options": { name: "Product Options", description: "Opções/adicionais de produto" },
  "purchase-goals": { name: "Purchase Goals", description: "Objetivos de compra" },
  "customer-tracking": { name: "Customer Tracking", description: "Rastreamento de clientes" },
  ifood: { name: "iFood", description: "Integração iFood (import + API oficial)" },
  stripe: { name: "Stripe", description: "Pagamentos online (Stripe Connect)" },
  pagarme: { name: "Pagar.me", description: "Pagamentos online (Pagar.me)" },
  providers: { name: "Companies", description: "Fornecedores por cidade" },
  "search-address": { name: "Connections", description: "Busca de endereço" },
  public: { name: "Public", description: "Fluxo público (sem autenticação) — pedidos, cardápio, pagamento" },
};

// Atalhos de tipo para montar schemas de forma compacta.
const T = {
  str: { type: "string" },
  int: { type: "integer" },
  num: { type: "number" },
  bool: { type: "boolean" },
  arr: (items) => ({ type: "array", items }),
  obj: (properties) => ({ type: "object", properties }),
};

// Monta um requestBody JSON com schema tipado + exemplo.
function body(properties, example, required = []) {
  return {
    required: required.length > 0,
    content: {
      "application/json": {
        schema: { type: "object", properties, ...(required.length ? { required } : {}) },
        example,
      },
    },
  };
}

// Modelo de empresa reutilizado nos updates (companies / companiessss).
const COMPANY_PROPS = {
  id: T.int, name: T.str, description: T.str, phone: T.str, status: T.bool,
  logo_url: T.str, brand_color: T.str, banner_url: T.str,
  accepts_delivery: T.bool, accepts_pickup: T.bool,
  max_distance_meters_delivery: T.int, max_distance_meters_free_delivery: T.int,
  kilometer_price: T.num, min_price_order: T.num, min_tax_delivery: T.num,
  ai_name: T.str, ai_gender: T.str, ai_personality: T.str, cuisine_type: T.str,
};
const COMPANY_EXAMPLE = {
  id: 12, name: "Pizzaria do João", description: "A melhor pizza da cidade", phone: "5511999998888",
  status: true, logo_url: "https://cdn/logo.png", brand_color: "#4262FF",
  accepts_delivery: true, accepts_pickup: true,
  max_distance_meters_delivery: 8000, max_distance_meters_free_delivery: 2000,
  kilometer_price: 2.5, min_price_order: 20, min_tax_delivery: 5,
};

// Enriquecimento manual por operação ("MÉTODO /api/caminho"): resumo, descrição
// e corpo (schema + exemplo). Deriva dos controllers/services reais.
const OVERRIDES = {
  // ── Auth / cadastro ──────────────────────────────────────────────────────
  "POST /api/signin": {
    summary: "Login (e-mail + senha)",
    description: "Retorna o JWT usado em `Authorization: Bearer <token>`.",
    requestBody: body({ email: T.str, password: T.str }, { email: "user@exemplo.com", password: "••••••••" }, ["email", "password"]),
  },
  "POST /api/auth/google": {
    summary: "Login com Google (ID token)",
    requestBody: body({ credential: T.str }, { credential: "<google_id_token>" }, ["credential"]),
  },
  "POST /api/register": {
    summary: "Cadastro de usuário (pré-login)",
    requestBody: body({ name: T.str, email: T.str, password: T.str }, { name: "João Silva", email: "joao@exemplo.com", password: "••••••••" }, ["name", "email", "password"]),
  },
  "POST /api/companies/withoutid": {
    summary: "Criar empresa do usuário logado (vincula user_companies)",
    requestBody: body({ name: T.str, description: T.str, phone: T.str }, { name: "Pizzaria do João", description: "A melhor pizza da cidade", phone: "5511999998888" }, ["name"]),
  },
  "POST /api/companies": {
    summary: "Criar empresa (fluxo de registro)",
    requestBody: body({ name: T.str, description: T.str, phone: T.str, user: T.int, type: T.str }, { name: "Pizzaria do João", description: "...", phone: "5511999998888", user: 12, type: "owner" }, ["name"]),
  },
  "POST /api/users": {
    summary: "Criar/convidar usuário",
    requestBody: body({ name: T.str, email: T.str, link: T.str, active: T.bool }, { name: "Maria", email: "maria@exemplo.com", link: "https://portal.exemplo.com/ativar", active: true }, ["name", "email"]),
  },
  "POST /api/send-email": {
    summary: "Enviar e-mail",
    requestBody: body({ email: T.str, subject: T.str, html: T.str, text: T.str, link: T.str }, { email: "destino@exemplo.com", subject: "Bem-vindo", html: "<h1>Olá</h1>", text: "Olá", link: "https://portal.exemplo.com" }, ["email", "subject"]),
  },
  "PATCH /api/account": {
    summary: "Atualizar conta do usuário logado",
    requestBody: body({ name: T.str, email: T.str, phone: T.str, document: T.str, birthday: T.str, active: T.bool }, { name: "João Silva", phone: "5511999998888", document: "12345678900", birthday: "1990-05-20" }),
  },

  // ── Empresa ────────────────────────────────────────────────────────────────
  "PATCH /api/companies": {
    summary: "Atualizar empresa (id no corpo)",
    requestBody: body(COMPANY_PROPS, COMPANY_EXAMPLE, ["id"]),
  },
  "PATCH /api/companiessss": {
    summary: "Atualizar empresa (CRUD completo)",
    requestBody: body(COMPANY_PROPS, COMPANY_EXAMPLE, ["id"]),
  },
  "PATCH /api/company/address": {
    summary: "Atualizar endereço da empresa",
    requestBody: body(
      { company_id: T.int, street: T.str, number: T.str, complement: T.str, neighborhood: T.str, city: T.str, state: T.str, zip_code: T.str, latitude: T.num, longitude: T.num, is_main: T.bool },
      { company_id: 12, street: "Av. Paulista", number: "1000", complement: "Sala 5", neighborhood: "Bela Vista", city: "São Paulo", state: "SP", zip_code: "01310-100", latitude: -23.561, longitude: -46.655, is_main: true },
      ["company_id"],
    ),
  },
  "POST /api/company_opening_hours": {
    summary: "Criar horário de funcionamento",
    requestBody: body({ company_id: T.int, weekday: T.int, opens_at: T.str, closes_at: T.str, is_closed: T.bool }, { company_id: 12, weekday: 1, opens_at: "18:00", closes_at: "23:30", is_closed: false }, ["company_id", "weekday"]),
  },
  "POST /api/additional_info": {
    summary: "Criar informação adicional",
    requestBody: body({ company_id: T.int, title: T.str, content: T.str, category: T.str, trigger_keywords: T.str, visibility: T.str }, { company_id: 12, title: "Política de troca", content: "Trocamos em até 7 dias.", category: "atendimento", trigger_keywords: "troca, devolução", visibility: "public" }, ["company_id", "title"]),
  },

  // ── Cardápio ────────────────────────────────────────────────────────────────
  "POST /api/menu_categories": {
    summary: "Criar categoria do cardápio",
    requestBody: body({ company_id: T.int, name: T.str, sort_order: T.int, active: T.bool }, { company_id: 12, name: "Pizzas", sort_order: 1, active: true }, ["company_id", "name"]),
  },
  "PATCH /api/menu_categories/{id}": {
    summary: "Atualizar categoria",
    requestBody: body({ name: T.str, sort_order: T.int, active: T.bool }, { name: "Bebidas", sort_order: 2, active: true }),
  },
  "POST /api/menu_items": {
    summary: "Criar item do cardápio",
    requestBody: body(
      { company_id: T.int, category_id: T.int, name: T.str, description: T.str, price: T.num, available: T.bool, image_url: T.str, featured: T.bool, display_order: T.int, prep_time_minutes: T.int, sku: T.str },
      { company_id: 12, category_id: 3, name: "Pizza Margherita", description: "Molho, mussarela e manjericão", price: 49.9, available: true, image_url: "https://cdn/pizza.png", featured: false },
      ["company_id", "name", "price"],
    ),
  },
  "PATCH /api/menu_items": {
    summary: "Atualizar item do cardápio (id no corpo)",
    requestBody: body(
      { id: T.int, company_id: T.int, category_id: T.int, name: T.str, description: T.str, price: T.num, available: T.bool, image_url: T.str },
      { id: 55, company_id: 12, category_id: 3, name: "Pizza Margherita", price: 52.0, available: true },
      ["id"],
    ),
  },
  "POST /api/product-options": {
    summary: "Criar grupo de opções/adicionais de um produto",
    requestBody: body(
      { company_id: T.int, product_id: T.int, name: T.str, type: { type: "string", enum: ["single", "multiple"] }, min_selection: T.int, max_selection: T.int, is_required: T.bool, sort_order: T.int, items: T.arr(T.obj({ name: T.str, additional_price: T.num, sort_order: T.int, is_active: T.bool, image_url: T.str })) },
      { company_id: 12, product_id: 55, name: "Borda recheada", type: "single", min_selection: 0, max_selection: 1, is_required: false, sort_order: 0, items: [{ name: "Catupiry", additional_price: 8.0, is_active: true }, { name: "Cheddar", additional_price: 8.0, is_active: true }] },
      ["company_id", "product_id", "name"],
    ),
  },
  "POST /api/payment_methods": {
    summary: "Criar forma de pagamento",
    requestBody: body({ company_id: T.int, type: T.str, label: T.str, description: T.str, active: T.bool }, { company_id: 12, type: "pix", label: "PIX", description: "Pagamento via PIX", active: true }, ["company_id", "type"]),
  },

  // ── Clientes / pedidos ───────────────────────────────────────────────────────
  "POST /api/clients": {
    summary: "Criar cliente",
    requestBody: body(
      { company_id: T.int, name: T.str, phone: T.str, street: T.str, number: T.str, complement: T.str, neighborhood: T.str, city: T.str, state: T.str, zip_code: T.str, note: T.str },
      { company_id: 12, name: "Ana Souza", phone: "5511988887777", street: "Rua A", number: "100", neighborhood: "Centro", city: "São Paulo", state: "SP", zip_code: "01000-000" },
      ["company_id", "name", "phone"],
    ),
  },
  "POST /api/orders": {
    summary: "Criar pedido (admin)",
    description: "O total é recalculado no servidor a partir dos itens.",
    requestBody: body(
      {
        company_id: T.int, client_id: T.int, delivery_type: { type: "string", enum: ["delivery", "pickup"], description: "ou boolean (true=entrega)" },
        delivery_fee: T.num, discount: T.num, payment_method_id: T.int, delivery_address: T.str, notes: T.str,
        items: T.arr(T.obj({ menu_item_id: T.int, name: T.str, quantity: T.int, unit_price: T.num, subtotal: T.num })),
      },
      { company_id: 12, client_id: 34, delivery_type: "delivery", delivery_fee: 7.5, discount: 0, payment_method_id: 2, delivery_address: "Rua A, 100 - Centro", notes: "Sem cebola", items: [{ menu_item_id: 55, name: "Pizza Margherita", quantity: 2, unit_price: 49.9, subtotal: 99.8 }] },
      ["company_id", "items"],
    ),
  },
  "PATCH /api/orders/{id}/status": {
    summary: "Atualizar status do pedido",
    requestBody: body({ status: T.int, cancel_reason: T.str }, { status: 4, cancel_reason: null }, ["status"]),
  },
  "POST /api/delivery-drivers": {
    summary: "Criar motoboy",
    requestBody: body({ company_id: T.int, name: T.str, phone: T.str, whatsapp: T.str, plate: T.str, notes: T.str, is_active: T.bool }, { company_id: 12, name: "Carlos", phone: "5511977776666", whatsapp: "5511977776666", plate: "ABC1D23", is_active: true }, ["company_id", "name"]),
  },

  // ── Conexões WhatsApp ────────────────────────────────────────────────────────
  "POST /api/connections": {
    summary: "Criar conexão WhatsApp (Evolution)",
    requestBody: body(
      { integration: T.str, instanceName: T.str, qrcode: T.bool, company: T.int, description: T.str, rejectCall: T.bool, groupsIgnore: T.bool, syncFullHistory: T.bool },
      { integration: "WHATSAPP-BAILEYS", instanceName: "pizzaria-joao", qrcode: true, company: 12, description: "Atendimento principal", rejectCall: true, groupsIgnore: true, syncFullHistory: false },
      ["integration", "instanceName", "company"],
    ),
  },

  // ── Marketing (promoções / campanhas / upsell / metas) ───────────────────────
  "POST /api/promotions": {
    summary: "Criar promoção / combo",
    requestBody: body(
      { company_id: T.int, name: T.str, description: T.str, image_url: T.str, active: T.bool, discount_percent: T.num, final_price: T.num, items: T.arr(T.obj({ menu_item_id: T.int, quantity: T.int })) },
      { company_id: 12, name: "Combo Família", description: "2 pizzas + refri", active: true, discount_percent: 15, items: [{ menu_item_id: 55, quantity: 2 }, { menu_item_id: 80, quantity: 1 }] },
      ["company_id", "name", "items"],
    ),
  },
  "POST /api/campaigns": {
    summary: "Criar campanha de marketing",
    requestBody: body(
      { company_id: T.int, title: T.str, description: T.str, image_url: T.str, audience_type: T.str, audience_limit: T.int, inactive_days: T.int, schedule_type: T.str, scheduled_date: T.str, period: T.str, valid_until: T.str },
      { company_id: 12, title: "Volta pra gente!", description: "10% off", audience_type: "inactive", inactive_days: 30, schedule_type: "now", period: "immediate", valid_until: "2026-08-31" },
      ["company_id", "title"],
    ),
  },
  "POST /api/upsell": {
    summary: "Criar regra de upsell",
    requestBody: body(
      { company_id: T.int, trigger_item_id: T.int, description: T.str, active: T.bool, max_suggestions: T.int, items: T.arr(T.obj({ menu_item_id: T.int, discount_type: { type: "string", enum: ["percent", "final_price"] }, discount_value: T.num })) },
      { company_id: 12, trigger_item_id: 55, description: "Sugerir bebida com a pizza", active: true, max_suggestions: 3, items: [{ menu_item_id: 80, discount_type: "percent", discount_value: 10 }] },
      ["company_id", "trigger_item_id", "items"],
    ),
  },
  "POST /api/purchase-goals": {
    summary: "Criar objetivo de compra",
    requestBody: body({ company_id: T.int, name: T.str, description: T.str, discount_percentage: T.num, is_active: T.bool, category_ids: T.arr(T.int) }, { company_id: 12, name: "Frete grátis acima de R$80", description: "...", discount_percentage: 100, is_active: true, category_ids: [3, 4] }, ["company_id", "name"]),
  },

  // ── iFood ────────────────────────────────────────────────────────────────────
  "POST /api/ifood/merchant": {
    summary: "Salvar/atualizar merchant iFood (vazio desvincula)",
    requestBody: body({ company_id: T.int, merchant_id: T.str }, { company_id: 12, merchant_id: "abc-123-def" }, ["company_id"]),
  },

  // ── Pagamentos ───────────────────────────────────────────────────────────────
  "POST /api/stripe/connect": {
    summary: "Iniciar onboarding Stripe Connect da empresa",
    requestBody: body({ company_id: T.int }, { company_id: 12 }, ["company_id"]),
  },
  "POST /api/public/stripe/checkout": {
    summary: "Criar sessão de checkout Stripe de um pedido",
    requestBody: body({ order_id: T.int }, { order_id: 789 }, ["order_id"]),
  },
  "POST /api/public/stripe/payment-intent": {
    summary: "Criar PaymentIntent (Payment Element) de um pedido",
    requestBody: body({ order_id: T.int }, { order_id: 789 }, ["order_id"]),
  },
  "POST /api/pagarme/connect": {
    summary: "Onboarding do recebedor Pagar.me",
    requestBody: body({ company_id: T.int, register_information: T.obj({}), default_bank_account: T.obj({}) }, { company_id: 12, register_information: { type: "individual", document: "12345678900" }, default_bank_account: { bank: "341", branch_number: "0001", account_number: "12345", account_check_digit: "6" } }, ["company_id"]),
  },
  "POST /api/public/pagarme/card": {
    summary: "Pagar pedido com cartão (token client-side)",
    requestBody: body({ order_id: T.int, card_token: T.str, document: T.str, email: T.str, name: T.str, phone: T.str }, { order_id: 789, card_token: "token_test_xxx", document: "12345678900", email: "ana@exemplo.com", name: "Ana Souza", phone: "5511988887777" }, ["order_id", "card_token"]),
  },
  "POST /api/public/pagarme/pix": {
    summary: "Pagar pedido com PIX",
    requestBody: body({ order_id: T.int, document: T.str, email: T.str, name: T.str, phone: T.str }, { order_id: 789, document: "12345678900", email: "ana@exemplo.com", name: "Ana Souza", phone: "5511988887777" }, ["order_id"]),
  },

  // ── Fluxo público de pedidos ─────────────────────────────────────────────────
  "POST /api/public/clients": {
    summary: "Criar cliente (fluxo público)",
    requestBody: body(
      { company_id: T.int, name: T.str, phone: T.str, street: T.str, number: T.str, complement: T.str, neighborhood: T.str, city: T.str, state: T.str, zip_code: T.str },
      { company_id: 12, name: "Ana Souza", phone: "5511988887777", street: "Rua A", number: "100", neighborhood: "Centro", city: "São Paulo", state: "SP", zip_code: "01000-000" },
      ["company_id", "name", "phone"],
    ),
  },
  "POST /api/public/orders": {
    summary: "Criar pedido (fluxo público)",
    description: "Preços e total são recalculados no servidor. `payment_provider` habilita pagamento online.",
    requestBody: body(
      {
        company_id: T.int, client_id: T.int, notes: T.str, scheduled_for: T.str, payment_method_id: T.int,
        payment_provider: { type: "string", enum: ["stripe", "pagarme"], nullable: true },
        delivery_type: { type: "string", enum: ["delivery", "pickup"] }, delivery_address: T.str, delivery_fee: T.num,
        items: T.arr(T.obj({ menu_item_id: T.int, promotion_id: T.int, quantity: T.int })),
      },
      { company_id: 12, client_id: 34, delivery_type: "delivery", delivery_address: "Rua A, 100", delivery_fee: 7.5, payment_method_id: 2, payment_provider: null, items: [{ menu_item_id: 55, quantity: 2 }] },
      ["company_id", "items"],
    ),
  },

  // ── Toggles de status ────────────────────────────────────────────────────────
  "PATCH /api/promotions/{id}/status": { summary: "Ativar/desativar promoção", requestBody: body({ active: T.bool }, { active: true }, ["active"]) },
  "PATCH /api/upsell/{id}/status": { summary: "Ativar/desativar regra de upsell", requestBody: body({ active: T.bool }, { active: true }, ["active"]) },
  "PATCH /api/purchase-goals/{id}/status": { summary: "Ativar/desativar objetivo de compra", requestBody: body({ is_active: T.bool }, { is_active: true }, ["is_active"]) },
};

// ─── Helpers de introspecção ───────────────────────────────────────────────────

const expressPathToOpenApi = (p) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const extractParams = (p) => {
  const out = [];
  const re = /:([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(p))) out.push(m[1]);
  return out;
};

const routeRequiresAuth = (route) =>
  route.stack.some((l) => l.handle && l.handle.name === "authMiddleware");

const firstSegment = (p) => p.split("/").filter(Boolean)[0] || "root";

const tagFor = (seg) => (TAG_META[seg] ? TAG_META[seg].name : seg);

// Resumo legível a partir do método + caminho.
function summarize(method, rawPath) {
  const isPublic = rawPath.startsWith("/public");
  const clean = rawPath.replace(/^\/public\//, "").replace(/^\//, "");
  const hasIdTail = /\/:(id|companyId|orderId|groupId|productId|placeId|instance)\b[^/]*$/.test(rawPath);
  const verb =
    method === "get" ? (rawPath.includes(":") ? "Consultar" : "Listar")
    : method === "post" ? "Criar"
    : method === "put" || method === "patch" ? "Atualizar"
    : method === "delete" ? "Remover"
    : method.toUpperCase();
  const suffix = isPublic ? " (público)" : "";
  return `${verb} — ${clean}${suffix}`.trim();
}

// ─── Construção do documento OpenAPI ───────────────────────────────────────────

function buildSpec() {
  const paths = {};
  const usedTags = new Map();

  router.stack.forEach((layer) => {
    const route = layer.route;
    if (!route || typeof route.path !== "string") return;

    const rawPath = route.path;
    const oaPath = "/api" + expressPathToOpenApi(rawPath);
    const seg = firstSegment(rawPath);
    const tag = tagFor(seg);
    if (TAG_META[seg]) usedTags.set(tag, TAG_META[seg].description);

    const requiresAuth = routeRequiresAuth(route);
    const params = extractParams(rawPath).map((name) => ({
      name,
      in: "path",
      required: true,
      description: /company/i.test(name) ? "ID da empresa" : undefined,
      schema: { type: "string" },
    }));

    const methods = Object.keys(route.methods).filter((m) => m !== "_all");
    methods.forEach((method) => {
      const key = `${method.toUpperCase()} ${oaPath}`;
      const ov = OVERRIDES[key] || {};
      const op = {
        tags: [tag],
        summary: ov.summary || summarize(method, rawPath),
        description: ov.description,
        security: requiresAuth ? [{ bearerAuth: [] }, { apiKey: [] }] : [],
        parameters: params.length ? params : undefined,
        responses: {
          200: { description: "Sucesso" },
          ...(requiresAuth ? { 401: { description: "Não autenticado (token/API key ausente ou inválido)" }, 403: { description: "Sem acesso a esta empresa (multi-tenant)" } } : {}),
          400: { description: "Requisição inválida" },
          500: { description: "Erro interno" },
        },
      };
      if (["post", "put", "patch"].includes(method)) {
        op.requestBody = ov.requestBody || {
          required: false,
          content: { "application/json": { schema: { type: "object" } } },
        };
      }
      paths[oaPath] = paths[oaPath] || {};
      paths[oaPath][method] = op;
    });
  });

  const tags = [...usedTags.entries()].map(([name, description]) => ({ name, description }));

  return {
    openapi: "3.0.3",
    info: {
      title: "AutomatizAI — API",
      version: "1.0.0",
      description:
        "Documentação das rotas da API (gerada automaticamente a partir do router).\n\n" +
        "**Autenticação:** rotas protegidas aceitam **JWT** (`Authorization: Bearer <token>`, obtido em `POST /api/signin`) " +
        "ou a **API Key de serviço** (`x-api-key`, para integrações máquina→máquina como o n8n). " +
        "Rotas em `/api/public/*` e webhooks não exigem JWT.",
    },
    servers: [
      { url: "http://localhost:" + (process.env.PORT || 3003), description: "Desenvolvimento" },
      { url: "https://api.iasemburocracia.com.br", description: "Produção" },
    ],
    tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "JWT do login (`POST /api/signin`)." },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "API Key de serviço (n8n) — variável `N8N_API_KEY`." },
      },
    },
    paths,
  };
}

// ─── Montagem no app Express ────────────────────────────────────────────────────

function mount(app) {
  // Permite desligar a doc em produção definindo DOCS_ENABLED=false.
  if (process.env.DOCS_ENABLED === "false") return;

  const spec = buildSpec();

  // Spec cru (útil para importar no Postman/Insomnia ou gerar clients).
  app.get("/api/docs.json", (req, res) => res.json(spec));

  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: "AutomatizAI — API Docs",
      swaggerOptions: { persistAuthorization: true, docExpansion: "none", filter: true, tagsSorter: "alpha" },
    }),
  );

  console.log("📚 Swagger UI em /api/docs (spec em /api/docs.json)");
}

module.exports = { mount, buildSpec };
