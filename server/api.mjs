import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import { promisify } from "node:util";
import { getDatabase } from "./db.mjs";

const derive = promisify(scrypt);

const passwordOptions = {
  N: 65536,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

const STORE = "selani-main";
const COOKIE = "selani_owner";
const SESSION_HOURS = 8;

function digest(value) {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");

  const key = await derive(
    password,
    salt,
    64,
    passwordOptions,
  );

  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");

  const valid =
    /^[a-f0-9]{32}$/.test(salt || "") &&
    /^[a-f0-9]{128}$/.test(hash || "");

  const key = await derive(
    password,
    valid ? salt : "0".repeat(32),
    64,
    passwordOptions,
  );

  const expected = Buffer.from(
    valid ? hash : "0".repeat(128),
    "hex",
  );

  return timingSafeEqual(key, expected) && valid;
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function sessionCookie(request, token, clear = false) {
  const secure =
    new URL(request.url).protocol === "https:"
      ? "; Secure"
      : "";

  const maxAge = clear
    ? 0
    : SESSION_HOURS * 3600;

  return (
    `${COOKIE}=${clear ? "" : token}; ` +
    `Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${maxAge}${secure}`
  );
}

function tokenFrom(request) {
  const value = (request.headers.get("cookie") || "")
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);

  return /^[a-f0-9]{64}$/.test(value || "")
    ? value
    : null;
}

async function allowLoginAttempt(db, key, maximum) {
  const bucket = Math.floor(Date.now() / 900000);

  const result = await db
    .collection("login_limits")
    .findOneAndUpdate(
      {
        _id: `${digest(key)}:${bucket}`,
      },
      {
        $inc: {
          count: 1,
        },
        $setOnInsert: {
          expiresAt: new Date(
            (bucket + 2) * 900000,
          ),
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    );

  return result.count <= maximum;
}

function dateStart(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) {
    return null;
  }

  const utc = new Date(`${value}T00:00:00Z`);

  if (
    !Number.isFinite(utc.getTime()) ||
    utc.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  // Sri Lanka midnight, converted to UTC.
  return new Date(
    utc.getTime() - 330 * 60000,
  );
}

export async function handleRequest(
  request,
  context = {},
) {
  try {
    const url = new URL(request.url);
    const route = url.pathname;

    if (request.method === "POST") {
      if (
        request.headers.get("origin") !== url.origin
      ) {
        return json(
          { error: "This request is not allowed." },
          403,
        );
      }

      const contentType =
        request.headers.get("content-type") || "";

      if (
        !/^application\/json(?:;|$)/i.test(contentType)
      ) {
        return json(
          { error: "Send a JSON request." },
          415,
        );
      }
    }

    const db = await getDatabase();

    if (
      route === "/api/login" &&
      request.method === "POST"
    ) {
      const text = await request.text();

      if (Buffer.byteLength(text) > 4096) {
        return json(
          { error: "Request is too large." },
          413,
        );
      }

      let body;

      try {
        body = JSON.parse(text);
      } catch {
        return json(
          { error: "Invalid request." },
          400,
        );
      }

      const email =
        typeof body?.email === "string"
          ? body.email.trim().toLowerCase()
          : "";

      const password = body?.password;

      if (
        !email ||
        email.length > 254 ||
        typeof password !== "string" ||
        !password ||
        password.length > 128
      ) {
        return json(
          { error: "Enter your email and password." },
          400,
        );
      }

      const ipAllowed = await allowLoginAttempt(
        db,
        `ip:${context.ip || "unknown"}`,
        40,
      );

      const emailAllowed =
        ipAllowed &&
        (await allowLoginAttempt(
          db,
          `email:${email}`,
          10,
        ));

      if (!emailAllowed) {
        return json(
          {
            error:
              "Too many attempts. Try again in 15 minutes.",
          },
          429,
          {
            "Retry-After": "900",
          },
        );
      }

      const owner = await db
        .collection("owners")
        .findOne({
          _id: "owner",
          email,
        });

      const correct = await verifyPassword(
        password,
        owner?.passwordHash,
      );

      if (!owner || !correct) {
        return json(
          {
            error:
              "Email or password is incorrect.",
          },
          401,
        );
      }

      const token =
        randomBytes(32).toString("hex");

      await db.collection("sessions").insertOne({
        _id: digest(token),
        ownerId: "owner",
        email,
        expiresAt: new Date(
          Date.now() +
            SESSION_HOURS * 3600000,
        ),
      });

      return json(
        {
          owner: { email },
        },
        200,
        {
          "Set-Cookie": sessionCookie(
            request,
            token,
          ),
        },
      );
    }

    const token = tokenFrom(request);

    const session = token
      ? await db.collection("sessions").findOne({
          _id: digest(token),
          expiresAt: {
            $gt: new Date(),
          },
        })
      : null;

    if (!session) {
      return json(
        { error: "Please log in again." },
        401,
      );
    }

    if (
      route === "/api/me" &&
      request.method === "GET"
    ) {
      return json({
        owner: {
          email: session.email,
        },
      });
    }

    if (
      route === "/api/logout" &&
      request.method === "POST"
    ) {
      await db.collection("sessions").deleteOne({
        _id: digest(token),
      });

      return json(
        { ok: true },
        200,
        {
          "Set-Cookie": sessionCookie(
            request,
            "",
            true,
          ),
        },
      );
    }

    if (
      route === "/api/reports" &&
      request.method === "GET"
    ) {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      const page = Number(
        url.searchParams.get("page") || 1,
      );

      const start = dateStart(from);
      const last = dateStart(to);

      if (
        !start ||
        !last ||
        last < start ||
        last - start > 30 * 86400000 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 5000
      ) {
        return json(
          {
            error:
              "Choose a valid range of up to 31 days.",
          },
          400,
        );
      }

      const [result] = await db
        .collection("sales")
        .aggregate([
          {
            $match: {
              storeId: STORE,
              paidAt: {
                $gte: start,
                $lt: new Date(
                  last.getTime() + 86400000,
                ),
              },
            },
          },
          {
            $facet: {
              summary: [
                {
                  $group: {
                    _id: null,
                    count: {
                      $sum: 1,
                    },
                    totalCents: {
                      $sum: "$totalCents",
                    },
                    cashCents: {
                      $sum: {
                        $cond: [
                          {
                            $eq: [
                              "$method",
                              "cash",
                            ],
                          },
                          "$totalCents",
                          0,
                        ],
                      },
                    },
                    cardCents: {
                      $sum: {
                        $cond: [
                          {
                            $eq: [
                              "$method",
                              "card",
                            ],
                          },
                          "$totalCents",
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
              orders: [
                {
                  $sort: {
                    paidAt: -1,
                    clientId: 1,
                  },
                },
                {
                  $skip: (page - 1) * 20,
                },
                {
                  $limit: 20,
                },
                {
                  $project: {
                    _id: 0,
                    clientId: 1,
                    orderId: 1,
orderNumber: 1,
orderDate: 1,
dailyNumber: 1,
                    orderType: 1,
                    method: 1,
                    totalCents: 1,
                    paidAt: 1,
                    items: 1,
                  },
                },
              ],
            },
          },
        ])
        .toArray();

      const state = await db
        .collection("sync_state")
        .findOne({
          _id: STORE,
        });

      return json({
        from,
        to,
        page,
        pageSize: 20,
        timeZone: "Asia/Colombo",
        summary: result?.summary[0] || {
          count: 0,
          totalCents: 0,
          cashCents: 0,
          cardCents: 0,
        },
        orders: result?.orders || [],
        lastSyncedAt:
          state?.lastSyncedAt || null,
      });
    }

    return json(
      { error: "Page not found." },
      404,
    );
  } catch (error) {
    console.error(
      "[Selani Owner API]",
      error.name,
      error.code || "",
    );

    return json(
      {
        error:
          "Could not reach the reporting service. Please try again.",
      },
      503,
    );
  }
}
// SELANI_DAILY_ORDERS_V1
