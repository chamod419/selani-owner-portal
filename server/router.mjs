import { handleRequest } from "./api.mjs";
import { handleSync } from "./sync.mjs";

export function routeRequest(
  request,
  context = {},
) {
  const pathname =
    new URL(request.url).pathname;

  if (pathname === "/api/sync") {
    return handleSync(request);
  }

  return handleRequest(request, context);
}