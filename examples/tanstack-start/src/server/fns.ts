import { createServerFn } from "@tanstack/react-start";
import { withDebug } from "@debugkit/sdk/node";
import { ensureServerDebug } from "./debug";

/** A server function that fails the way a real payment call might. */
export const chargeCard = createServerFn({ method: "POST" }).handler(
  withDebug("checkout.payment", async () => {
    ensureServerDebug().breadcrumb("network", "POST https://payments.example/v1/intents → 502", undefined, "error");
    throw new Error("Payment provider returned 502 Bad Gateway");
  }),
);
