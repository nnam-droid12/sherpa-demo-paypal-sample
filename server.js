import express from "express";
import "dotenv/config";
import crypto from "node:crypto";
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import bodyParser from "body-parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();
app.enable("trust proxy");
app.use(bodyParser.json());

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_WEBHOOK_ID,
  PORT = 8080,
} = process.env;

// Packaging for Sherpa: serve the HTML client from this server and inject the client ID,
// which Vite's dev server did in the original sample.
const clientDir = fileURLToPath(new URL("./client", import.meta.url));
const page = readFileSync(`${clientDir}/index.html`, "utf8").replaceAll(
  "%PAYPAL_CLIENT_ID%",
  PAYPAL_CLIENT_ID || ""
);
app.get("/", (_req, res) => res.type("html").send(page));
app.get("/thank-you", (_req, res) => res.type("html").send(page));
app.get("/cart", (_req, res) => res.type("html").send(page));
app.use(express.static(clientDir));

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID,
    oAuthClientSecret: PAYPAL_CLIENT_SECRET,
  },
  timeout: 0,
  environment: Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: {
      logBody: true,
    },
    logResponse: {
      logHeaders: true,
    },
  },
});

const ordersController = new OrdersController(client);

// Server-side product catalog
const CATALOG = {
  YOUR_PRODUCT_ID: { id: "YOUR_PRODUCT_ID", name: "Sample Item", price: "100.00" },
  "item-1": { id: "item-1", name: "Sample Item 1", price: "100.00" },
  "product-1": { id: "product-1", name: "Sample Product 1", price: "100.00" },
  "1": { id: "1", name: "Sample Item 1", price: "100.00" },
};

/**
 * Compute the order amount on the server from the server-side catalog
 * (product ids and quantities only) before creating the order.
 * Never trust a total sent by the browser.
 */
const calculateCartTotal = (cart) => {
  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return "100.00";
  }
  let totalCents = 0;
  for (const item of cart) {
    if (!item) continue;
    const catalogItem = item.id ? CATALOG[item.id] : null;
    const priceStr = catalogItem ? catalogItem.price : "100.00";
    const priceCents = Math.round(parseFloat(priceStr) * 100);
    const qty = parseInt(item.quantity, 10);
    const validQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
    totalCents += priceCents * validQty;
  }
  return (totalCents / 100).toFixed(2);
};

// In-memory order tracking
const orders = new Map();

// In-memory cart tracking for PayPal Cart API v1
const carts = new Map();

const getOrigin = (req) => {
  let proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  if (proto.includes(",")) proto = proto.split(",")[0].trim();
  let host =
    req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;
  if (host.includes(",")) host = host.split(",")[0].trim();
  return `${proto}://${host}`;
};

function validateAndPriceCart(reqBody, existingCart = null, isNew = true) {
  const issues = [];
  const processedItems = [];
  let subtotalCents = 0;

  const rawItems = Array.isArray(reqBody.items) ? reqBody.items : [];

  if (!rawItems || rawItems.length === 0) {
    issues.push({
      code: "INVENTORY_ISSUE",
      type: "MISSING_FIELD",
      message: "Cart must contain at least one item.",
      user_message: "Your cart is empty.",
      field: "items",
      context: { specific_issue: "EMPTY_CART" },
      resolution_options: [{ action: "ADD_ITEMS" }],
    });
  } else {
    for (const item of rawItems) {
      if (!item || !item.item_id) {
        issues.push({
          code: "INVENTORY_ISSUE",
          type: "MISSING_FIELD",
          message: "Item is missing item_id.",
          field: "items",
        });
        continue;
      }
      const catalogItem = CATALOG[item.item_id];
      if (!catalogItem) {
        issues.push({
          code: "INVENTORY_ISSUE",
          type: "INVALID_DATA",
          message: `Item '${item.item_id}' not found in catalog.`,
          user_message: `Item '${item.item_id}' is not available.`,
          field: "items",
          context: { specific_issue: "UNKNOWN_ITEM", item_id: item.item_id },
        });
        continue;
      }
      const qty = parseInt(item.quantity, 10);
      if (Number.isInteger(qty) && qty <= 0) {
        issues.push({
          code: "INVENTORY_ISSUE",
          type: "INVALID_DATA",
          message: "Quantity must be greater than zero.",
          field: "items",
        });
        continue;
      }
      const validQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
      const priceVal = catalogItem.price || "100.00";
      const priceCents = Math.round(parseFloat(priceVal) * 100);
      subtotalCents += priceCents * validQty;

      processedItems.push({
        item_id: catalogItem.id,
        quantity: validQty,
        name: catalogItem.name,
        price: {
          currency_code: "USD",
          value: parseFloat(priceVal).toFixed(2),
        },
      });
    }
  }

  // Shipping address validation
  const shippingAddress = reqBody.shipping_address;
  if (
    !shippingAddress ||
    typeof shippingAddress !== "object" ||
    !shippingAddress.address_line_1 ||
    !shippingAddress.country_code
  ) {
    issues.push({
      code: "SHIPPING_ERROR",
      type: "MISSING_FIELD",
      message: "A shipping address is required.",
      user_message: "Please provide a shipping address.",
      field: "shipping_address",
      context: { specific_issue: "MISSING_SHIPPING_ADDRESS" },
      resolution_options: [{ action: "PROVIDE_MISSING_FIELD" }],
    });
  }

  const subtotalStr = (subtotalCents / 100).toFixed(2);
  const totalStr = subtotalStr;

  const validationStatus = issues.length === 0 ? "VALID" : "INVALID";
  let status = "CREATED";
  if (!isNew && validationStatus === "INVALID") {
    status = "INCOMPLETE";
  }

  const cartId = existingCart
    ? existingCart.id
    : "cart_" + crypto.randomBytes(4).toString("hex");

  const cart = {
    id: cartId,
    status: status,
    validation_status: validationStatus,
    validation_issues: issues,
    items: processedItems,
    totals: {
      subtotal: { currency_code: "USD", value: subtotalStr },
      shipping: { currency_code: "USD", value: "0.00" },
      tax: { currency_code: "USD", value: "0.00" },
      total: { currency_code: "USD", value: totalStr },
    },
    payment_method: { type: reqBody.payment_method?.type || "paypal" },
  };

  if (reqBody.customer) {
    cart.customer = reqBody.customer;
  }
  if (reqBody.shipping_address) {
    cart.shipping_address = reqBody.shipping_address;
  }
  if (reqBody.checkout_fields) {
    cart.checkout_fields = reqBody.checkout_fields;
  }

  return cart;
}

// Deduplicate webhooks: keep a processedEvents Set of event ids
const processedEvents = new Set();

let cachedAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Get OAuth access token for PayPal REST API calls
 */
async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiryTime) {
    return cachedAccessToken;
  }
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const response = await fetch(
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`,
      },
      body: "grant_type=client_credentials",
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to retrieve PayPal access token: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  cachedAccessToken = data.access_token;
  tokenExpiryTime = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return cachedAccessToken;
}

/**
 * Create a PayPal order for Cart API v1 with experience_context
 */
async function createCartPayPalOrder(cart, origin) {
  const accessToken = await getAccessToken();
  const totalAmount = cart.totals.total.value;
  const currencyCode = cart.totals.total.currency_code || "USD";

  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: currencyCode,
          value: totalAmount,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: `${origin}/thank-you`,
          cancel_url: `${origin}/cart`,
          user_action: "PAY_NOW",
        },
      },
    },
  };

  const response = await fetch(
    "https://api-m.sandbox.paypal.com/v2/checkout/orders",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "PayPal-Request-Id": crypto.randomUUID(),
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    console.error("PayPal create order failed:", data);
    throw new Error(data.message || "Failed to create PayPal order");
  }

  if (data.id) {
    orders.set(data.id, {
      id: data.id,
      expectedAmount: totalAmount,
      cart: cart.items.map((i) => ({ id: i.item_id, quantity: i.quantity })),
      status: "CREATED",
      paid: false,
      fulfilled: false,
      createdAt: new Date().toISOString(),
    });
  }

  return data.id;
}

/**
 * Create an order to start the transaction.
 * Sends a unique PayPal-Request-Id header (crypto.randomUUID()) on every POST.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_create
 */
const createOrder = async (cart) => {
  const totalAmount = calculateCartTotal(cart);
  const paypalRequestId = crypto.randomUUID();

  const collect = {
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          amount: {
            currencyCode: "USD",
            value: totalAmount,
          },
        },
      ],
    },
    paypalRequestId, // Sets 'PayPal-Request-Id': crypto.randomUUID()
    prefer: "return=representation",
  };

  try {
    const { body, ...httpResponse } = await ordersController.createOrder(
      collect
    );
    const jsonResponse = JSON.parse(body);

    if (jsonResponse?.id) {
      orders.set(jsonResponse.id, {
        id: jsonResponse.id,
        expectedAmount: totalAmount,
        cart,
        status: "CREATED",
        paid: false,
        fulfilled: false,
        createdAt: new Date().toISOString(),
      });
    }

    return {
      jsonResponse,
      httpStatusCode: httpResponse.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      let errorBody = {};
      try {
        errorBody =
          typeof error.body === "string" ? JSON.parse(error.body) : error.body;
      } catch {
        errorBody = { message: error.message };
      }
      return {
        jsonResponse: errorBody,
        httpStatusCode: error.statusCode || 500,
      };
    }
    throw error;
  }
};

/**
 * Capture payment for the created order to complete the transaction.
 * Sends a unique PayPal-Request-Id header (crypto.randomUUID()) on every POST.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_capture
 */
const captureOrder = async (orderID) => {
  const paypalRequestId = crypto.randomUUID();
  const collect = {
    id: orderID,
    paypalRequestId, // Sets 'PayPal-Request-Id': crypto.randomUUID()
    prefer: "return=representation",
  };

  try {
    const { body, ...httpResponse } = await ordersController.captureOrder(
      collect
    );
    const jsonResponse = JSON.parse(body);

    const capture =
      jsonResponse?.purchase_units?.[0]?.payments?.captures?.[0];
    const captureStatus = capture?.status || jsonResponse?.status;
    const capturedAmount = capture?.amount?.value;

    const order = orders.get(orderID);

    // Verify the captured amount matches the server-computed order amount
    if (order && capturedAmount && capturedAmount !== order.expectedAmount) {
      return {
        jsonResponse: {
          error: "AMOUNT_MISMATCH",
          message: "Captured amount does not match expected order amount",
          details: [
            {
              issue: "AMOUNT_MISMATCH",
              description: `Captured amount ${capturedAmount} does not match expected ${order.expectedAmount}`,
            },
          ],
        },
        httpStatusCode: 400,
      };
    }

    // Treat a capture whose status is "PENDING" as not yet paid:
    // only mark the order paid for a "COMPLETED" capture.
    if (order) {
      order.captureId = capture?.id;
      if (captureStatus === "COMPLETED") {
        order.status = "COMPLETED";
        order.paid = true;
        order.fulfilled = true;
      } else if (captureStatus === "PENDING") {
        order.status = "PENDING";
        order.paid = false;
        order.fulfilled = false;
      } else {
        order.status = captureStatus;
        order.paid = false;
        order.fulfilled = false;
      }
    }

    return {
      jsonResponse,
      httpStatusCode: httpResponse.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      let errorBody = {};
      try {
        errorBody =
          typeof error.body === "string" ? JSON.parse(error.body) : error.body;
      } catch {
        errorBody = { message: error.message };
      }
      return {
        jsonResponse: errorBody,
        httpStatusCode: error.statusCode || 422,
      };
    }
    throw error;
  }
};

app.post("/api/orders", async (req, res) => {
  try {
    // Only pass cart from front-end; server calculates order amount from catalog
    const cart = req.body?.cart || [];
    const { jsonResponse, httpStatusCode } = await createOrder(cart);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    const { orderID } = req.params;
    const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to capture order:", error);
    res.status(500).json({ error: "Failed to capture order." });
  }
});

app.get("/api/orders/:orderID", (req, res) => {
  const order = orders.get(req.params.orderID);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(order);
});

/**
 * Catalog feed for AI shopping agents.
 * GET /catalog.json
 */
app.get("/catalog.json", (req, res) => {
  const origin = getOrigin(req);
  res.json({
    items: [
      {
        id: "YOUR_PRODUCT_ID",
        title: "Sample Item",
        description: "Sample Item",
        price: {
          currency_code: "USD",
          value: "100.00",
        },
        availability: "in_stock",
        image_url: null,
        url: `${origin}/`,
        variants: [],
      },
    ],
  });
});

/**
 * PayPal Cart API v1: Create cart
 * POST /merchant-cart
 */
app.post("/merchant-cart", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        name: "INVALID_REQUEST",
        message: "Request body must be a JSON object",
        debug_id: crypto.randomUUID(),
      });
    }

    const cart = validateAndPriceCart(req.body, null, true);
    if (cart.items.length > 0 && parseFloat(cart.totals.total.value) > 0) {
      try {
        const orderId = await createCartPayPalOrder(cart, getOrigin(req));
        cart.payment_method.token = orderId;
      } catch (err) {
        console.error("Failed to create PayPal order for cart:", err);
        return res.status(500).json({
          name: "INTERNAL_SERVER_ERROR",
          message: err.message || "Failed to create PayPal order",
          debug_id: crypto.randomUUID(),
        });
      }
    }

    carts.set(cart.id, cart);
    return res.status(201).json(cart);
  } catch (error) {
    console.error("POST /merchant-cart error:", error);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: error.message || "Failed to create cart",
      debug_id: crypto.randomUUID(),
    });
  }
});

/**
 * PayPal Cart API v1: Read cart
 * GET /merchant-cart/{id}
 */
app.get("/merchant-cart/:id", (req, res) => {
  const { id } = req.params;
  const cart = carts.get(id);
  if (!cart) {
    return res.status(404).json({
      name: "CART_NOT_FOUND",
      message: `Cart '${id}' not found`,
      debug_id: crypto.randomUUID(),
    });
  }
  return res.status(200).json(cart);
});

/**
 * PayPal Cart API v1: Replace cart (full replace)
 * PUT /merchant-cart/{id}
 */
app.put("/merchant-cart/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existingCart = carts.get(id);
    if (!existingCart) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${id}' not found`,
        debug_id: crypto.randomUUID(),
      });
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        name: "INVALID_REQUEST",
        message: "Request body must be a JSON object",
        debug_id: crypto.randomUUID(),
      });
    }

    const updatedCart = validateAndPriceCart(req.body, existingCart, false);
    if (
      updatedCart.items.length > 0 &&
      parseFloat(updatedCart.totals.total.value) > 0
    ) {
      try {
        const orderId = await createCartPayPalOrder(updatedCart, getOrigin(req));
        updatedCart.payment_method.token = orderId;
      } catch (err) {
        console.error("Failed to recreate PayPal order for cart:", err);
        return res.status(500).json({
          name: "INTERNAL_SERVER_ERROR",
          message: err.message || "Failed to recreate PayPal order",
          debug_id: crypto.randomUUID(),
        });
      }
    }

    carts.set(id, updatedCart);
    return res.status(200).json(updatedCart);
  } catch (error) {
    console.error("PUT /merchant-cart error:", error);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: error.message || "Failed to update cart",
      debug_id: crypto.randomUUID(),
    });
  }
});

/**
 * PayPal Cart API v1: Complete checkout
 * POST /merchant-cart/{id}/checkout
 */
app.post("/merchant-cart/:id/checkout", async (req, res) => {
  try {
    const { id } = req.params;
    const cart = carts.get(id);
    if (!cart) {
      return res.status(404).json({
        name: "CART_NOT_FOUND",
        message: `Cart '${id}' not found`,
        debug_id: crypto.randomUUID(),
      });
    }

    if (cart.status === "COMPLETED") {
      return res.status(200).json(cart);
    }

    // If validation_status is INVALID return 200 with the cart and its issues
    if (cart.validation_status === "INVALID") {
      return res.status(200).json(cart);
    }

    const orderId = cart.payment_method?.token;
    if (!orderId) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "The buyer must approve the PayPal payment first.",
        debug_id: crypto.randomUUID(),
      });
    }

    const accessToken = await getAccessToken();

    // Fetch the PayPal order
    const orderRes = await fetch(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!orderRes.ok) {
      const errData = await orderRes.json().catch(() => ({}));
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: errData.message || "Could not retrieve PayPal order.",
        debug_id: errData.debug_id || crypto.randomUUID(),
      });
    }

    const orderData = await orderRes.json();

    // If it is not yet approved return 422
    if (orderData.status !== "APPROVED" && orderData.status !== "COMPLETED") {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: "The buyer must approve the PayPal payment first.",
        debug_id: orderData.debug_id || crypto.randomUUID(),
      });
    }

    let capturedAmount = null;

    if (orderData.status === "APPROVED") {
      // Capture it
      const captureRes = await fetch(
        `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "PayPal-Request-Id": crypto.randomUUID(),
            Prefer: "return=representation",
          },
          body: JSON.stringify({}),
        }
      );

      const captureData = await captureRes.json();
      if (!captureRes.ok) {
        return res.status(422).json({
          name: "UNPROCESSABLE_ENTITY",
          message: captureData.message || "Failed to capture PayPal payment.",
          debug_id: captureData.debug_id || crypto.randomUUID(),
        });
      }

      const capture =
        captureData?.purchase_units?.[0]?.payments?.captures?.[0];
      capturedAmount = capture?.amount?.value;
    } else if (orderData.status === "COMPLETED") {
      const capture =
        orderData?.purchase_units?.[0]?.payments?.captures?.[0];
      capturedAmount =
        capture?.amount?.value || orderData?.purchase_units?.[0]?.amount?.value;
    }

    // Verify the captured amount equals the cart total
    if (
      capturedAmount &&
      parseFloat(capturedAmount) !== parseFloat(cart.totals.total.value)
    ) {
      return res.status(422).json({
        name: "UNPROCESSABLE_ENTITY",
        message: `Captured amount ${capturedAmount} does not match cart total ${cart.totals.total.value}`,
        debug_id: crypto.randomUUID(),
      });
    }

    // Set status COMPLETED and add payment_confirmation
    const origin = getOrigin(req);
    const merchantOrderNumber = `order_${cart.id.replace("cart_", "")}_${Date.now()}`;
    cart.status = "COMPLETED";
    cart.payment_confirmation = {
      merchant_order_number: merchantOrderNumber,
      order_review_page: `${origin}/thank-you?order_id=${merchantOrderNumber}`,
    };

    carts.set(cart.id, cart);

    const trackedOrder = orders.get(orderId);
    if (trackedOrder) {
      trackedOrder.status = "COMPLETED";
      trackedOrder.paid = true;
      trackedOrder.fulfilled = true;
    }

    return res.status(200).json(cart);
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({
      name: "INTERNAL_SERVER_ERROR",
      message: error.message || "Checkout failed",
      debug_id: crypto.randomUUID(),
    });
  }
});

/**
 * Webhook listener:
 * Verifies every event with PayPal's POST /v1/notifications/verify-webhook-signature,
 * rejects unverified events with 400, deduplicates with processedEvents Set,
 * and handles PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, and CHECKOUT.ORDER.APPROVED.
 */
app.post("/api/webhooks/paypal", async (req, res) => {
  try {
    const event = req.body;
    if (!event || !event.id) {
      return res.status(400).json({ error: "Missing webhook payload" });
    }

    // Deduplicate webhooks: keep a processedEvents Set of event ids,
    // and when processedEvents.has(event.id) return 200 without processing the event again.
    if (processedEvents.has(event.id)) {
      return res.status(200).json({ status: "already_processed" });
    }

    const authAlgo = req.headers["paypal-auth-algo"];
    const certUrl = req.headers["paypal-cert-url"];
    const transmissionId = req.headers["paypal-transmission-id"];
    const transmissionSig = req.headers["paypal-transmission-sig"];
    const transmissionTime = req.headers["paypal-transmission-time"];
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (
      !authAlgo ||
      !certUrl ||
      !transmissionId ||
      !transmissionSig ||
      !transmissionTime ||
      !webhookId
    ) {
      return res.status(400).json({
        error:
          "Missing required webhook verification headers or PAYPAL_WEBHOOK_ID",
      });
    }

    const accessToken = await getAccessToken();
    const verifyResponse = await fetch(
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: event,
        }),
      }
    );

    if (!verifyResponse.ok) {
      return res
        .status(400)
        .json({ error: "Webhook verification request failed" });
    }

    const verifyData = await verifyResponse.json();
    if (verifyData.verification_status !== "SUCCESS") {
      return res
        .status(400)
        .json({ error: "Webhook signature verification failed" });
    }

    // Mark as processed to prevent duplicates
    processedEvents.add(event.id);

    // Handle supported webhook events
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        const capture = event.resource;
        const orderId =
          capture?.supplementary_data?.related_ids?.order_id ||
          capture?.custom_id;
        let order = orderId ? orders.get(orderId) : null;
        if (!order) {
          for (const o of orders.values()) {
            if (o.captureId === capture?.id) {
              order = o;
              break;
            }
          }
        }
        if (order) {
          order.status = "COMPLETED";
          order.paid = true;
          order.fulfilled = true;
          order.captureId = capture?.id;
        }
        console.log(
          `Webhook: PAYMENT.CAPTURE.COMPLETED processed for capture ${capture?.id}`
        );
        break;
      }
      case "PAYMENT.CAPTURE.DENIED": {
        const capture = event.resource;
        const orderId =
          capture?.supplementary_data?.related_ids?.order_id ||
          capture?.custom_id;
        let order = orderId ? orders.get(orderId) : null;
        if (!order) {
          for (const o of orders.values()) {
            if (o.captureId === capture?.id) {
              order = o;
              break;
            }
          }
        }
        if (order) {
          order.status = "DENIED";
          order.paid = false;
          order.fulfilled = false;
        }
        console.log(
          `Webhook: PAYMENT.CAPTURE.DENIED processed for capture ${capture?.id}`
        );
        break;
      }
      case "CHECKOUT.ORDER.APPROVED": {
        const approvedOrder = event.resource;
        const order = orders.get(approvedOrder?.id);
        if (order) {
          order.status = "APPROVED";
        }
        console.log(
          `Webhook: CHECKOUT.ORDER.APPROVED processed for order ${approvedOrder?.id}`
        );
        break;
      }
      default:
        console.log(`Webhook: unhandled event type ${event.event_type}`);
    }

    return res.status(200).json({ status: "success" });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`Node server listening at http://localhost:${PORT}/`);
  });
}

export {
  app,
  orders,
  carts,
  CATALOG,
  calculateCartTotal,
  processedEvents,
  createOrder,
  captureOrder,
};

