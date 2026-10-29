import React, {
  useCallback,
  useEffect,
  useState,
} from "react";

import { createRoot } from "react-dom/client";
import "./styles.css";

const currency = new Intl.NumberFormat("en-LK", {
  style: "currency",
  currency: "LKR",
});

function money(cents) {
  return currency.format((cents || 0) / 100);
}

function dateTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function today() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ]),
  );

  return (
    `${values.year}-${values.month}` +
    `-${values.day}`
  );
}

function orderNumber(order) {
  const value =
    Number.isSafeInteger(order.dailyNumber) &&
    order.dailyNumber > 0
      ? String(order.dailyNumber)
      : String(
          order.orderNumber ?? "",
        ).replace(/^\d{8}-/, "");

  if (!/^\d+$/.test(value)) {
    return "Pending sync";
  }

  return (
    "#" +
    value
      .replace(/^0+(?=\d)/, "")
      .padStart(5, "0")
  );
}

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    ...options,

    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },

    signal:
      options.signal ||
      AbortSignal.timeout(20000),
  });

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      body.error ||
      "Unable to complete the request.",
    );

    error.status = response.status;

    throw error;
  }

  return body;
}

function Brand() {
  return (
    <div className="brand">
      <img
        src="/selani-logo.png"
        alt=""
        onError={(event) => {
          event.currentTarget.style.display =
            "none";
        }}
      />

      <div>
        <strong>SELANI</strong>
        <span>OWNER PORTAL</span>
      </div>
    </div>
  );
}

function Login({ onLogin, initialError }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState(
    initialError || "",
  );

  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();

    setBusy(true);
    setError("");

    try {
      const result = await api("login", {
        method: "POST",

        body: JSON.stringify({
          email,
          password,
        }),
      });

      setPassword("");
      onLogin(result.owner);
    } catch (failure) {
      setError(
        failure.message ||
        "Connection failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <Brand />

        <div className="story-copy">
          <p className="eyebrow">
            SELANI RESTAURANT
          </p>

          <h1>
            A clear view of
            <br />
            your restaurant.
          </h1>

          <p>
            Your sales, orders and daily performance.
            <br />
            Wherever the day takes you.
          </p>

          <div className="story-rule" />

          <span>
            Thoughtfully served. Clearly reported.
          </span>
        </div>

        <small>Powered by CMNexa</small>
      </section>

      <section className="login-panel">
        <form
          className="login-form"
          onSubmit={submit}
        >
          <p className="eyebrow">
            WELCOME BACK
          </p>

          <h2>Owner sign in</h2>

          <p className="muted">
            Sign in to view your restaurant’s sales.
          </p>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <label htmlFor="email">
            Email address
          </label>

          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <label htmlFor="password">
            Password
          </label>

          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />

          <button
            className="primary"
            disabled={busy}
          >
            {busy ? "Signing in…" : "Sign in"}
            <span aria-hidden="true">→</span>
          </button>

          <p className="login-note">
            Private access for the restaurant owner.
          </p>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ owner, onLogout }) {
  const [dates, setDates] = useState({
    from: today(),
    to: today(),
  });

  const [query, setQuery] = useState({
    ...dates,
    page: 1,
  });

  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(null);

  const [signingOut, setSigningOut] =
    useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, 20000);

    let active = true;

    setLoading(true);
    setError("");
    setReport(null);
    setExpanded(null);

    const parameters =
      new URLSearchParams(query);

    api(`reports?${parameters}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (active) {
          setReport(data);
        }
      })
      .catch((failure) => {
        if (!active) {
          return;
        }

        if (failure.status === 401) {
          onLogout();
          return;
        }

        setError(
          failure.name === "AbortError"
            ? "The report took too long. Please refresh."
            : failure.message,
        );
      })
      .finally(() => {
        clearTimeout(timer);

        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;

      clearTimeout(timer);
      controller.abort();
    };
  }, [query, refresh, onLogout]);

  async function logout() {
    setSigningOut(true);
    setError("");

    try {
      await api("logout", {
        method: "POST",
        body: "{}",
      });

      onLogout();
    } catch (failure) {
      if (failure.status === 401) {
        onLogout();
      } else {
        setError(
          "Could not sign out. Please try again.",
        );
      }
    } finally {
      setSigningOut(false);
    }
  }

  const synced = Boolean(
    report?.lastSyncedAt,
  );

  const pages = Math.max(
    1,
    Math.ceil(
      (report?.summary.count || 0) / 20,
    ),
  );

  const metrics = [
    [
      "Total sales",
      "totalCents",
      "Completed payments",
      true,
    ],
    [
      "Cash sales",
      "cashCents",
      "Cash payments",
    ],
    [
      "Card sales",
      "cardCents",
      "Bank terminal payments",
    ],
    [
      "Paid orders",
      "count",
      "Completed orders",
    ],
  ];

  let syncLabel = "Waiting for first sync";

  if (loading) {
    syncLabel = "Checking sync…";
  } else if (error && !report) {
    syncLabel = "Report unavailable";
  } else if (synced) {
    syncLabel = "Cloud reports";
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />

        <div className="account">
          <span>{owner.email}</span>

          <button
            className="quiet"
            onClick={logout}
            disabled={signingOut}
          >
            {signingOut
              ? "Signing out…"
              : "Sign out"}
          </button>
        </div>
      </header>

      <main className="dashboard">
        <div className="page-heading">
          <div>
            <p className="eyebrow">
              YOUR RESTAURANT, AT A GLANCE
            </p>

            <h1>Sales overview</h1>

            <p className="muted">
              Paid orders · Sri Lanka time
            </p>
          </div>

          <span
            className={
              `status ${synced ? "connected" : ""}`
            }
          >
            <i />
            {syncLabel}
          </span>
        </div>

        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();

            setQuery({
              ...dates,
              page: 1,
            });
          }}
        >
          <label>
            From

            <input
              type="date"
              required
              min="2000-01-01"
              max="2099-12-31"
              value={dates.from}
              onChange={(event) => {
                setDates({
                  ...dates,
                  from: event.target.value,
                });
              }}
            />
          </label>

          <label>
            To

            <input
              type="date"
              required
              min={dates.from}
              max="2099-12-31"
              value={dates.to}
              onChange={(event) => {
                setDates({
                  ...dates,
                  to: event.target.value,
                });
              }}
            />
          </label>

          <button
            className="primary"
            disabled={loading}
          >
            View report
          </button>

          <button
            className="quiet"
            type="button"
            disabled={loading}
            onClick={() => {
              const value = today();

              setDates({
                from: value,
                to: value,
              });

              setQuery({
                from: value,
                to: value,
                page: 1,
              });
            }}
          >
            Today
          </button>

          <button
            className="refresh"
            type="button"
            disabled={loading}
            onClick={() => {
              setRefresh(
                (value) => value + 1,
              );
            }}
          >
            ↻ Refresh
          </button>
        </form>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {!loading && report && !synced && (
          <div className="notice">
            <strong>
              Your portal is ready.
            </strong>

            <span>
              Sales will appear after we connect this
              portal to the cashier app. No orders have
              been synced yet.
            </span>
          </div>
        )}

        <div className="metrics">
          {metrics.map(
            ([label, key, caption, featured]) => (
              <section
                className={
                  `metric ${featured ? "featured" : ""}`
                }
                key={key}
              >
                <p>{label}</p>

                <strong>
                  {loading || !synced
                    ? "—"
                    : key === "count"
                      ? report.summary[key]
                      : money(report.summary[key])}
                </strong>

                <small>{caption}</small>
              </section>
            ),
          )}
        </div>

        <section className="orders-panel">
          <div className="panel-heading">
            <div>
              <h2>Paid orders</h2>

              <p className="muted">
                {report
                  ? `${report.from} — ${report.to}`
                  : "Choose a reporting period"}
              </p>
            </div>

            <span className="order-count">
              {report?.summary.count || 0} orders
            </span>
          </div>

          {loading ? (
            <div
              className="empty"
              role="status"
            >
              <span className="empty-symbol">
                ◌
              </span>

              <h3>Loading your report…</h3>
            </div>
          ) : !report?.orders.length ? (
            <div className="empty">
              <span className="empty-symbol">
                ≡
              </span>

              <h3>
                {error
                  ? "Report unavailable"
                  : synced
                    ? "No paid orders in this period"
                    : "Your first report starts here"}
              </h3>

              <p>
                {error
                  ? "Refresh to try again."
                  : synced
                    ? "Choose another date range to see more sales."
                    : "Completed cashier orders will appear here after syncing."}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Payment time</th>
                    <th>Type</th>
                    <th>Payment</th>

                    <th className="amount">
                      Total
                    </th>

                    <th>
                      <span className="sr-only">
                        Details
                      </span>
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {report.orders.map((order) => (
                    <React.Fragment
                      key={order.clientId}
                    >
                      <tr>
                        <td>
                          <strong>
                            {orderNumber(order)}
                          </strong>
                        </td>

                        <td>
                          {dateTime(order.paidAt)}
                        </td>

                        <td>
                          {order.orderType}
                        </td>

                        <td>
                          <span className="payment">
                            {order.method === "cash"
                              ? "Cash"
                              : "Card"}
                          </span>
                        </td>

                        <td className="amount">
                          {money(order.totalCents)}
                        </td>

                        <td>
                          <button
                            className="detail-button"
                            aria-expanded={
                              expanded ===
                              order.clientId
                            }
                            onClick={() => {
                              setExpanded(
                                expanded ===
                                  order.clientId
                                  ? null
                                  : order.clientId,
                              );
                            }}
                          >
                            {expanded ===
                            order.clientId
                              ? "Close"
                              : "Details"}
                          </button>
                        </td>
                      </tr>

                      {expanded ===
                        order.clientId && (
                        <tr className="detail-row">
                          <td colSpan={6}>
                            {order.orderDate && (
                              <p className="muted">
                                Order date:{" "}
                                {order.orderDate}
                              </p>
                            )}

                            <ul>
                              {(order.items || []).map(
                                (item, index) => (
                                  <li key={index}>
                                    <span>
                                      {item.quantity}
                                      {" × "}
                                      {item.name}

                                      {item.variantLabel
                                        ? ` · ${item.variantLabel}`
                                        : ""}
                                    </span>

                                    <strong>
                                      {money(
                                        item.priceCents *
                                        item.quantity,
                                      )}
                                    </strong>
                                  </li>
                                ),
                              )}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report && pages > 1 && (
            <div className="pagination">
              <button
                className="quiet"
                disabled={
                  loading ||
                  query.page <= 1
                }
                onClick={() => {
                  setQuery({
                    ...query,
                    page: query.page - 1,
                  });
                }}
              >
                Previous
              </button>

              <span>
                Page {query.page} of {pages}
              </span>

              <button
                className="quiet"
                disabled={
                  loading ||
                  query.page >= pages
                }
                onClick={() => {
                  setQuery({
                    ...query,
                    page: query.page + 1,
                  });
                }}
              >
                Next
              </button>
            </div>
          )}
        </section>

        <footer className="dashboard-footer">
          <span>
            Selani Restaurant · Owner access
          </span>

          <span>
            {report?.lastSyncedAt
              ? `Last synced: ${dateTime(report.lastSyncedAt)}`
              : error
                ? "Sync status unavailable"
                : "No sync received yet"}
          </span>
        </footer>
      </main>
    </div>
  );
}

function App() {
  const [owner, setOwner] = useState(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");

  const logout = useCallback(() => {
    setOwner(null);
  }, []);

  useEffect(() => {
    let active = true;

    api("me")
      .then((result) => {
        if (active) {
          setOwner(result.owner);
        }
      })
      .catch((failure) => {
        if (
          active &&
          failure.status !== 401
        ) {
          setError(
            "Reporting service unavailable. Please try signing in again.",
          );
        }
      })
      .finally(() => {
        if (active) {
          setBooting(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (booting) {
    return (
      <div className="boot" role="status">
        Opening Selani Owner Portal…
      </div>
    );
  }

  return owner ? (
    <Dashboard
      owner={owner}
      onLogout={logout}
    />
  ) : (
    <Login
      onLogin={setOwner}
      initialError={error}
    />
  );
}

createRoot(
  document.getElementById("root"),
).render(<App />);

// SELANI_DAILY_ORDERS_V1