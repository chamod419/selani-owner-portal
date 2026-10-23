import { routeRequest } from "../server/router.mjs";

const routes = new Set([
  "login",
  "logout",
  "me",
  "reports",
  "sync",
]);

export default {
  fetch(request) {
    const url = new URL(request.url);
    const route = url.searchParams.get("__route");

    if (!routes.has(route)) {
      return Response.json(
        { error: "Endpoint not found." },
        {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    url.pathname = `/api/${route}`;
    url.searchParams.delete("__route");

    const ip = (
      request.headers.get("x-vercel-forwarded-for") ||
      request.headers.get("x-forwarded-for") ||
      "unknown"
    )
      .split(",")[0]
      .trim();

    return routeRequest(
      new Request(url, request),
      { ip },
    );
  },
};