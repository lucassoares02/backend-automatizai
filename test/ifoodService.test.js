const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const pool = require("../db");

process.env.IFOOD_CLIENT_ID = "test-client-id";
process.env.IFOOD_CLIENT_SECRET = "test-client-secret";

const service = require("../services/ifoodService");
const controller = require("../controllers/ifoodController");

test("consulta usa o merchant_id recebido mesmo sem perfil salvo", async () => {
  const originalQuery = pool.query;
  const originalPost = axios.post;
  const originalGet = axios.get;
  const merchantId = "3fbf567f-7c4e-4541-be05-83168d2793e8";
  const requestedUrls = [];

  pool.query = async (sql) => {
    if (/SELECT id, name, ifood_merchant_id/i.test(sql)) {
      return {
        rows: [
          {
            id: 25,
            name: "Restaurante",
            ifood_merchant_id: null,
            ifood_merchant_name: null,
            ifood_connected_at: null,
          },
        ],
      };
    }
    return { rows: [] };
  };
  axios.post = async () => ({
    status: 200,
    data: { accessToken: "ifood-test-token", expiresIn: 3600 },
  });
  axios.get = async (url) => {
    requestedUrls.push(url);
    if (url.includes("/merchant/v1.0/merchants/")) {
      return { status: 200, data: { id: merchantId, name: "Restaurante" } };
    }
    return { status: 200, data: [] };
  };

  try {
    const result = await service.consult(25, merchantId);
    assert.equal(result.merchantId, merchantId);
    assert.equal(result.merchant.id, merchantId);
    assert.ok(
      requestedUrls.some((url) =>
        url.endsWith(`/merchant/v1.0/merchants/${merchantId}`),
      ),
    );
  } finally {
    pool.query = originalQuery;
    axios.post = originalPost;
    axios.get = originalGet;
  }
});

test("controller encaminha merchant_id da query para o service", async () => {
  const originalConsult = service.consult;
  const merchantId = "3fbf567f-7c4e-4541-be05-83168d2793e8";
  let received;

  service.consult = async (companyId, requestedMerchantId) => {
    received = { companyId, requestedMerchantId };
    return { merchantId: requestedMerchantId, products: [], orders: [] };
  };

  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  try {
    await controller.consult(
      { params: { companyId: "25" }, query: { merchant_id: merchantId } },
      response,
    );
    assert.deepEqual(received, {
      companyId: 25,
      requestedMerchantId: merchantId,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.merchantId, merchantId);
  } finally {
    service.consult = originalConsult;
  }
});

test("normaliza o item flat com grupos e complementos", () => {
  const result = service._private.normalizeProductDetails({
    item: {
      id: "item-1",
      productId: "product-1",
      categoryId: "category-1",
      type: "DEFAULT",
      status: "AVAILABLE",
      price: { value: 20, originalValue: 24 },
    },
    products: [
      {
        id: "product-1",
        name: "Sanduíche",
        description: "Pão, carne e queijo",
        imagePath: "https://images.example/sanduiche.jpg",
        optionGroups: [{ id: "group-1", min: 1, max: 2 }],
      },
      {
        id: "product-option-1",
        name: "Queijo extra",
        description: "Uma fatia adicional",
      },
    ],
    optionGroups: [
      {
        id: "group-1",
        name: "Adicionais",
        optionIds: ["option-1"],
      },
    ],
    options: [
      {
        id: "option-1",
        productId: "product-option-1",
        status: "AVAILABLE",
        price: { value: 3.5 },
      },
    ],
  });

  assert.equal(result.id, "item-1");
  assert.equal(result.name, "Sanduíche");
  assert.equal(result.price, 20);
  assert.equal(result.originalPrice, 24);
  assert.equal(result.optionGroups.length, 1);
  assert.equal(result.optionGroups[0].name, "Adicionais");
  assert.equal(result.optionGroups[0].min, 1);
  assert.equal(result.optionGroups[0].max, 2);
  assert.deepEqual(result.optionGroups[0].options[0], {
    id: "option-1",
    productId: "product-option-1",
    name: "Queijo extra",
    description: "Uma fatia adicional",
    price: 3.5,
    status: "AVAILABLE",
    externalCode: null,
    imageUrl: null,
  });
});

test("controller encaminha item e merchant para a consulta detalhada", async () => {
  const originalFetchProductDetails = service.fetchProductDetails;
  const merchantId = "3fbf567f-7c4e-4541-be05-83168d2793e8";
  const itemId = "058e0631-a643-45dd-b833-20a2178d2ae7";
  let received;

  service.fetchProductDetails = async (
    companyId,
    requestedItemId,
    requestedMerchantId,
  ) => {
    received = { companyId, requestedItemId, requestedMerchantId };
    return { merchantId: requestedMerchantId, itemId: requestedItemId, product: {} };
  };

  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  try {
    await controller.getProductDetails(
      {
        params: { companyId: "25", itemId },
        query: { merchant_id: merchantId },
      },
      response,
    );
    assert.deepEqual(received, {
      companyId: 25,
      requestedItemId: itemId,
      requestedMerchantId: merchantId,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.itemId, itemId);
  } finally {
    service.fetchProductDetails = originalFetchProductDetails;
  }
});
