let sdkInstance = null;
let paypalSession = null;
let venmoSession = null;

function resultMessage(message) {
  const container = document.querySelector("#result-message");
  if (container) {
    container.innerHTML = message;
    container.className = "result-message-box";
  }
}

function showAlert(message, isDeclined = false) {
  const alertContainer = document.querySelector("#alert-container");
  if (!alertContainer) return;

  alertContainer.setAttribute("role", "alert");
  alertContainer.style.display = "block";

  const messageText = isDeclined
    ? "Your payment method was declined. Please try again with a different payment method."
    : message;

  alertContainer.innerHTML = `
    <p class="alert-message">${messageText}</p>
    <button id="try-again-button" class="try-again-btn" type="button">Try again</button>
  `;

  const tryAgainButton = document.querySelector("#try-again-button");
  if (tryAgainButton) {
    tryAgainButton.addEventListener("click", () => {
      alertContainer.style.display = "none";
      if (sdkInstance) {
        createSessions(sdkInstance);
      }
    });
  }
}

async function createOrder() {
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cart: [
          {
            id: "YOUR_PRODUCT_ID",
            quantity: 1,
          },
        ],
      }),
    });

    const orderData = await response.json();
    const orderId = orderData.id || orderData.orderId;

    if (orderId) {
      return { orderId: orderId };
    }

    const errorDetail = orderData?.details?.[0];
    const errorMessage = errorDetail
      ? `${errorDetail.issue} ${errorDetail.description} (${orderData.debug_id || ""})`
      : JSON.stringify(orderData);

    throw new Error(errorMessage);
  } catch (error) {
    console.error("Could not initiate PayPal Checkout:", error);
    showAlert(`Could not initiate PayPal Checkout: ${error.message || error}`, false);
    throw error;
  }
}

async function handleApprove(data) {
  try {
    const orderId = data?.orderId || data?.orderID;
    const response = await fetch(`/api/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const orderData = await response.json();
    const errorDetail = orderData?.details?.[0];

    // Case 1: Recoverable INSTRUMENT_DECLINED
    if (errorDetail?.issue === "INSTRUMENT_DECLINED") {
      showAlert(
        "Your payment method was declined. Please choose a different payment method to complete your purchase.",
        true
      );
      if (sdkInstance) {
        createSessions(sdkInstance);
      }
      return;
    }

    // Case 2: Other errors
    if (!response.ok || errorDetail) {
      const msg = errorDetail
        ? `${errorDetail.description || errorDetail.issue} (${orderData.debug_id || ""})`
        : orderData.error || "Payment capture failed";
      showAlert(msg, false);
      return;
    }

    // Case 3: Successful or pending transaction
    const capture =
      orderData?.purchase_units?.[0]?.payments?.captures?.[0] ||
      orderData?.purchase_units?.[0]?.payments?.authorizations?.[0];
    const status = capture?.status || orderData?.status;

    if (status === "PENDING") {
      resultMessage(
        `Your payment is pending and being reviewed. We will update you once it clears.<br>Capture ID: ${capture?.id || orderData.id}`
      );
    } else if (status === "COMPLETED") {
      resultMessage(
        `Transaction COMPLETED: ${capture?.id || orderData.id}<br>Payment successful! Thank you for your purchase.`
      );
      console.log("Capture result", orderData, JSON.stringify(orderData, null, 2));
    } else {
      resultMessage(`Transaction ${status}: ${capture?.id || orderData.id}`);
    }
  } catch (error) {
    console.error("Capture approval error:", error);
    showAlert(`Sorry, your transaction could not be processed: ${error.message || error}`, false);
  }
}

function createSessions(sdk) {
  if (!sdk) return;

  if (typeof sdk.createPayPalOneTimePaymentSession === "function") {
    paypalSession = sdk.createPayPalOneTimePaymentSession({
      onApprove: handleApprove,
      onCancel: () => {
        console.log("PayPal payment cancelled by buyer");
      },
      onError: (err) => {
        console.error("PayPal session error:", err);
        showAlert(`Payment error: ${err?.message || err}`, false);
      },
    });
  }

  if (typeof sdk.createVenmoOneTimePaymentSession === "function") {
    venmoSession = sdk.createVenmoOneTimePaymentSession({
      onApprove: handleApprove,
      onCancel: () => {
        console.log("Venmo payment cancelled by buyer");
      },
      onError: (err) => {
        console.error("Venmo session error:", err);
        showAlert(`Venmo error: ${err?.message || err}`, false);
      },
    });
  }
}

async function startSessionWithRetry(session) {
  if (!session) return;
  try {
    await session.start({ presentationMode: "auto" }, createOrder());
  } catch (error) {
    const isPopupBlocked =
      error?.code === "ERR_DEV_UNABLE_TO_OPEN_POPUP" ||
      String(error?.message || error).includes("ERR_DEV_UNABLE_TO_OPEN_POPUP");
    if (isPopupBlocked) {
      await session.start({ presentationMode: "modal" }, createOrder());
    } else {
      throw error;
    }
  }
}

function renderButtons(methods) {
  const isPayPalEligible = methods?.isEligible ? methods.isEligible("paypal") : true;
  if (isPayPalEligible) {
    const paypalContainer = document.querySelector("#paypal-button-container");
    if (paypalContainer) {
      let paypalBtn = paypalContainer.querySelector("paypal-button");
      if (!paypalBtn) {
        paypalBtn = document.createElement("paypal-button");
        paypalBtn.setAttribute("type", "pay");
        paypalBtn.setAttribute("class", "paypal-gold");
        paypalContainer.appendChild(paypalBtn);
      }
      paypalBtn.addEventListener("click", async () => {
        try {
          await startSessionWithRetry(paypalSession);
        } catch (err) {
          console.error("PayPal session error:", err);
        }
      });
    }
  }

  const isVenmoEligible = methods?.isEligible ? methods.isEligible("venmo") : true;
  if (isVenmoEligible) {
    const venmoContainer = document.querySelector("#venmo-button-container");
    if (venmoContainer) {
      let venmoBtn = venmoContainer.querySelector("venmo-button");
      if (!venmoBtn) {
        venmoBtn = document.createElement("venmo-button");
        venmoBtn.setAttribute("type", "pay");
        venmoBtn.setAttribute("class", "venmo-blue");
        venmoContainer.appendChild(venmoBtn);
      }
      venmoBtn.addEventListener("click", async () => {
        try {
          await startSessionWithRetry(venmoSession);
        } catch (err) {
          console.error("Venmo session error:", err);
        }
      });
    }
  }
}

async function waitForPayPalSDK() {
  if (window.paypal && typeof window.paypal.createInstance === "function") {
    return window.paypal;
  }
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (window.paypal && typeof window.paypal.createInstance === "function") {
        clearInterval(interval);
        resolve(window.paypal);
      }
    }, 20);
    setTimeout(() => {
      clearInterval(interval);
      resolve(window.paypal);
    }, 10000);
  });
}

async function init() {
  const paypal = await waitForPayPalSDK();
  if (!paypal || typeof paypal.createInstance !== "function") {
    console.error("PayPal JS SDK v6 failed to load");
    return;
  }

  const clientId = window.PAYPAL_CLIENT_ID;

  try {
    sdkInstance = await window.paypal.createInstance({
      clientId,
      components: ["paypal-payments", "venmo-payments", "paypal-messages"],
      pageType: "checkout",
    });

    if (typeof sdkInstance.createPayPalMessages === "function") {
      sdkInstance.createPayPalMessages();
    }

    createSessions(sdkInstance);

    // If session.hasReturned() is true, resume instead of rendering buttons again
    if (typeof paypalSession?.hasReturned === "function" && paypalSession.hasReturned()) {
      await paypalSession.resume();
      return;
    }
    if (typeof venmoSession?.hasReturned === "function" && venmoSession.hasReturned()) {
      await venmoSession.resume();
      return;
    }

    const methods = await sdkInstance.findEligibleMethods({ currencyCode: "USD" });
    renderButtons(methods);
  } catch (err) {
    console.error("PayPal checkout initialization error:", err);
    showAlert(`PayPal checkout initialization error: ${err.message || err}`, false);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
