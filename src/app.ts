import { Hono } from "hono";
import type { Config } from "./config.js";
import { observe, type AppEnv } from "./events.js";
import { mcpRoutes } from "./mcp.js";
import { oauthRoutes } from "./oauth.js";
import type { Store } from "./store/types.js";

export function createApp(config: Config, store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const base = config.publicBaseUrl;

  app.use("*", observe(store));

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  const protectedResource = (c: { json: (o: unknown) => Response }) =>
    c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    }),
  );

  app.route("/", oauthRoutes(config, store));
  app.route("/", mcpRoutes(config, store));

  app.onError((err, c) => {
    console.error("unhandled error:", err instanceof Error ? err.message : "unknown");
    const evt = c.get("evt");
    if (evt) evt.error = "server_error";
    return c.json({ error: "server_error" }, 500);
  });

  return app;
}
