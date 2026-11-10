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
  CATALOG,
  calculateCartTotal,
  processedEvents,
  createOrder,
  captureOrder,
};

