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
