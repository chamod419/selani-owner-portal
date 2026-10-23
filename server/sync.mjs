import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

import { getDatabase } from "./db.mjs";

const STORE = "selani-main";
const MAX_BYTES = 256000;

const sha = (value) =>
  createHash("sha256")
    .update(value)
    .digest("hex");

class InvalidOrder extends Error {}

function response(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function integer(
  value,
  min,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new InvalidOrder("Invalid number.");
  }

  return value;
}

function text(value, maximum, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim())
  ) {
    throw new InvalidOrder("Invalid item text.");
  }

  return value;
}

function parseOrder(input) {
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  if (
    !input ||
    typeof input !== "object" ||
    !uuid.test(input.clientId || "")
  ) {
    throw new InvalidOrder("Invalid order ID.");
  }

  if (
    !["Dine-in", "Takeaway", "Delivery"].includes(
      input.orderType,
    ) ||
    !["cash", "card"].includes(input.method)
  ) {
    throw new InvalidOrder(
      "Invalid order type or payment.",
    );
  }

  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 100
  ) {
    throw new InvalidOrder("Invalid order items.");
  }

  const items = input.items.map((item) => ({
    name: text(item.name, 160),

    variantLabel: text(
      item.variantLabel || "",
      80,
      true,
    ),

    priceCents: integer(
      item.priceCents,
      1,
      100000000,
    ),

    quantity: integer(item.quantity, 1, 999),
  }));

  const totalCents = integer(
    input.totalCents,
    0,
  );

  const tenderedCents = integer(
    input.tenderedCents,
    0,
  );

  const changeCents = integer(
    input.changeCents,
    0,
  );

  const computed = items.reduce(
    (sum, item) =>
      sum + item.priceCents * item.quantity,
    0,
  );

  if (
    !Number.isSafeInteger(computed) ||
    computed !== totalCents ||
    tenderedCents - changeCents !== totalCents ||
    (input.method === "card" && changeCents !== 0)
  ) {
    throw new InvalidOrder(
      "Order totals do not match.",
    );
  }

  if (
    typeof input.paidAt !== "string" ||
    !/^20\d{2}-/.test(input.paidAt) ||
    input.paidAt.length > 35 ||
    !Number.isFinite(Date.parse(input.paidAt))
  ) {
    throw new InvalidOrder("Invalid payment time.");
  }

  return {
    clientId: input.clientId,
    orderId: integer(input.orderId, 1),
    orderType: input.orderType,
    method: input.method,
    totalCents,
    tenderedCents,
    changeCents,
    paidAt: new Date(input.paidAt).toISOString(),
    items,
  };
}

export async function handleSync(request) {
  try {
    if (request.method !== "POST") {
      return response(
        { error: "Use POST." },
        405,
      );
    }

    // POS uploads use a separate key.
    if (request.headers.has("origin")) {
      return response(
        {
          error:
            "Browser uploads are not allowed.",
        },
        403,
      );
    }

    const auth = /^Bearer ([a-f0-9]{64})$/.exec(
      request.headers.get("authorization") || "",
    );

    if (!auth) {
      return response(
        { error: "Upload key required." },
        401,
      );
    }

    const db = await getDatabase();

    const device = await db
      .collection("sync_devices")
      .findOne({
        _id: STORE,
      });

    const expected = device?.tokenHash;
    const actual = sha(auth[1]);

    if (
      !/^[a-f0-9]{64}$/.test(expected || "") ||
      !timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(actual, "hex"),
      )
    ) {
      return response(
        { error: "Upload key is invalid." },
        401,
      );
    }

    const contentType =
      request.headers.get("content-type") || "";

    if (
      !/^application\/json(?:;|$)/i.test(
        contentType,
      )
    ) {
      return response(
        { error: "Send JSON." },
        415,
      );
    }

    const raw = await request.text();

    if (Buffer.byteLength(raw) > MAX_BYTES) {
      return response(
        { error: "Upload is too large." },
        413,
      );
    }

    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      return response(
        { error: "Invalid JSON." },
        400,
      );
    }

    if (
      body?.version !== 1 ||
      typeof body.drained !== "boolean" ||
      !Array.isArray(body.orders) ||
      body.orders.length > 10
    ) {
      return response(
        { error: "Invalid sync request." },
        400,
      );
    }

    const orders = body.orders.map(parseOrder);

    const uniqueIds = new Set(
      orders.map((order) => order.clientId),
    );

    if (uniqueIds.size !== orders.length) {
      return response(
        {
          error:
            "Duplicate order IDs in upload.",
        },
        400,
      );
    }

    const now = new Date();

    if (orders.length) {
      const operations = orders.map((order) => {
        const fingerprint = sha(
          JSON.stringify(order),
        );

        return {
          updateOne: {
            filter: {
              storeId: STORE,
              clientId: order.clientId,
              fingerprint,
            },

            update: {
              $setOnInsert: {
                ...order,
                storeId: STORE,
                fingerprint,
                paidAt: new Date(order.paidAt),
                syncedAt: now,
              },
            },

            upsert: true,
          },
        };
      });

      await db.collection("sales").bulkWrite(
        operations,
        {
          ordered: true,
        },
      );
    }

    const status = {
      lastContactAt: now,
    };

    if (body.drained) {
      status.lastSyncedAt = now;
    }

    await db.collection("sync_state").updateOne(
      {
        _id: STORE,
      },
      {
        $max: status,
      },
      {
        upsert: true,
      },
    );

    return response({
      ok: true,

      acknowledged: orders.map(
        (order) => order.clientId,
      ),

      syncedAt: now.toISOString(),
    });
  } catch (error) {
    if (
      error instanceof InvalidOrder ||
      error instanceof TypeError
    ) {
      return response(
        {
          error:
            "A paid order has invalid data. Check the POS sync status.",
        },
        400,
      );
    }

    if (
      error.code === 11000 ||
      error.writeErrors?.some(
        (entry) => entry.code === 11000,
      )
    ) {
      return response(
        {
          error:
            "A paid order conflicts with an existing cloud record. No existing sale was replaced.",
        },
        409,
      );
    }

    console.error(
      "[Selani Sync API]",
      error.name,
      error.code || "",
    );

    return response(
      {
        error:
          "Cloud upload unavailable. The POS will retry.",
      },
      503,
    );
  }
}