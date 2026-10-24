const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const MARK = "// SELANI_DAILY_ORDERS_V1";

function syncModule() {
  const STORE = "selani-main";
  const MAX_BYTES = 256000;

  const sha = (value) =>
    createHash("sha256").update(value).digest("hex");

  const numberIndexes = new WeakMap();

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

  function text(
    value,
    maximum,
    allowEmpty = false,
  ) {
    if (
      typeof value !== "string" ||
      value.length > maximum ||
      (!allowEmpty && !value.trim())
    ) {
      throw new InvalidOrder("Invalid item text.");
    }

    return value;
  }

  // Preserve the old financial fingerprint format.
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

    const totalCents = integer(input.totalCents, 0);
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

  function parseNumbering(input) {
    if (
      input.orderDate === undefined &&
      input.dailyNumber === undefined &&
      input.orderNumber === undefined
    ) {
      return null;
    }

    const orderDate = input.orderDate;

    if (
      typeof orderDate !== "string" ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(orderDate)
    ) {
      throw new InvalidOrder("Invalid order date.");
    }

    const date = new Date(
      orderDate + "T00:00:00Z",
    );

    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== orderDate
    ) {
      throw new InvalidOrder("Invalid order date.");
    }

    const dailyNumber = integer(
      input.dailyNumber,
      1,
      999999999,
    );

    const orderNumber =
      orderDate.replaceAll("-", "") +
      "-" +
      String(dailyNumber).padStart(5, "0");

    if (input.orderNumber !== orderNumber) {
      throw new InvalidOrder(
        "Invalid order reference.",
      );
    }

    return {
      orderDate,
      dailyNumber,
      orderNumber,
    };
  }

  async function ensureNumberIndex(db) {
    if (!numberIndexes.has(db)) {
      const pending = db
        .collection("sales")
        .createIndex(
          {
            storeId: 1,
            orderNumber: 1,
          },
          {
            name: "store_daily_order_number",
            unique: true,
            partialFilterExpression: {
              orderNumber: {
                $type: "string",
              },
            },
          },
        );

      numberIndexes.set(db, pending);
    }

    try {
      await numberIndexes.get(db);
    } catch (error) {
      numberIndexes.delete(db);
      throw error;
    }
  }

  async function handleSync(request) {
    try {
      if (request.method !== "POST") {
        return response(
          { error: "Use POST." },
          405,
        );
      }

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
        .findOne({ _id: STORE });

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

      if (
        !/^application\/json(?:;|$)/i.test(
          request.headers.get("content-type") || "",
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

      const orders = body.orders.map((input) => ({
        financial: parseOrder(input),
        numbering: parseNumbering(input),
      }));

      const ids = orders.map(
        (order) => order.financial.clientId,
      );

      if (new Set(ids).size !== ids.length) {
        return response(
          {
            error:
              "Duplicate order IDs in upload.",
          },
          400,
        );
      }

      await ensureNumberIndex(db);

      const now = new Date();

      if (orders.length) {
        const operations = orders.map(
          ({ financial, numbering }) => {
            const fingerprint = sha(
              JSON.stringify(financial),
            );

            const filter = {
              storeId: STORE,
              clientId: financial.clientId,
              fingerprint,
            };

            const update = {
              $setOnInsert: {
                ...financial,
                storeId: STORE,
                fingerprint,
                paidAt: new Date(
                  financial.paidAt,
                ),
                syncedAt: now,
              },
            };

            if (numbering) {
              filter.$or = [
                {
                  orderNumber: {
                    $exists: false,
                  },
                },
                {
                  orderNumber:
                    numbering.orderNumber,
                },
              ];

              update.$set = numbering;
            }

            return {
              updateOne: {
                filter,
                update,
                upsert: true,
              },
            };
          },
        );

        await db.collection("sales").bulkWrite(
          operations,
          { ordered: true },
        );
      }

      const status = {
        lastContactAt: now,
      };

      if (body.drained) {
        status.lastSyncedAt = now;
      }

      await db.collection("sync_state").updateOne(
        { _id: STORE },
        { $max: status },
        { upsert: true },
      );

      return response({
        ok: true,
        numberingVersion: 1,
        acknowledged: ids,
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
              "A paid order or daily reference conflicts with an existing cloud record. No existing sale was replaced.",
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
}

function main() {
  const files = [
    "server/api.mjs",
    "server/sync.mjs",
    "src/main.jsx",
  ];

  const originals = new Map(
    files.map((file) => [
      file,
      fs.readFileSync(
        path.join(root, file),
        "utf8",
      ),
    ]),
  );

  const done = files.filter((file) =>
    originals.get(file).includes(MARK),
  );

  if (done.length === files.length) {
    console.log(
      "[OK] Owner portal daily references are already configured.",
    );
    return;
  }

  if (done.length) {
    throw new Error(
      "A partial update exists. Restore the source backup before retrying.",
    );
  }

  let api = originals.get("server/api.mjs");

  if (
    [...api.matchAll(/orderId:\s*1\s*,/g)]
      .length !== 1
  ) {
    throw new Error(
      "Report projection differs. No files changed.",
    );
  }

  api = api.replace(
    /orderId:\s*1\s*,/,
    () =>
      "orderId: 1,\norderNumber: 1,\norderDate: 1,\ndailyNumber: 1,",
  );

  const label =
    /\{String\(\s*order\.orderId\s*,?\s*\)\.padStart\(5,\s*["']0["']\)\}/g;

  const ui = originals.get("src/main.jsx");

  if ([...ui.matchAll(label)].length !== 1) {
    throw new Error(
      "Owner order label differs. No files changed.",
    );
  }

  const frontend = ui.replace(
    label,
    () =>
      '{order.orderNumber || String(order.orderId).padStart(5, "0")}',
  );

  const body = syncModule.toString();

  const sync =
    'import { createHash, timingSafeEqual } from "node:crypto";\n' +
    'import { getDatabase } from "./db.mjs";\n' +
    body
      .slice(
        body.indexOf("{") + 1,
        body.lastIndexOf("}"),
      )
      .replace(
        "async function handleSync(",
        "export async function handleSync(",
      );

  const updates = new Map(
    [
      ["server/api.mjs", api],
      ["server/sync.mjs", sync],
      ["src/main.jsx", frontend],
    ].map(([file, source]) => [
      file,
      source.trimEnd() + "\n" + MARK + "\n",
    ]),
  );

  for (const file of [
    "server/api.mjs",
    "server/sync.mjs",
  ]) {
    const temporary = path.join(
      root,
      file + ".daily-check.mjs",
    );

    try {
      fs.writeFileSync(
        temporary,
        updates.get(file),
        "utf8",
      );

      const checked = spawnSync(
        process.execPath,
        ["--check", temporary],
        { encoding: "utf8" },
      );

      if (
        checked.error ||
        checked.status !== 0
      ) {
        throw new Error(
          "Syntax check failed: " + file,
        );
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  const folder = path.join(
    root,
    "..",
    "selani-owner-source-backups",
    String(Date.now()),
  );

  for (const [file, source] of originals) {
    const destination = path.join(
      folder,
      file,
    );

    fs.mkdirSync(
      path.dirname(destination),
      { recursive: true },
    );

    fs.writeFileSync(
      destination,
      source,
      "utf8",
    );
  }

  try {
    for (const [file, source] of updates) {
      fs.writeFileSync(
        path.join(root, file),
        source,
        "utf8",
      );
    }
  } catch (error) {
    for (const [file, source] of originals) {
      fs.writeFileSync(
        path.join(root, file),
        source,
        "utf8",
      );
    }

    throw error;
  }

  console.log(
    "[OK] Source backup:",
    folder,
  );

  console.log(
    "[OK] Owner reports and sync now support daily references.",
  );

  console.log(
    "[NEXT] Run npm run build, then commit and push to GitHub.",
  );
}

try {
  main();
} catch (error) {
  console.error("[ERROR]", error.message);
  process.exitCode = 1;
}