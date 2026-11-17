import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createStore } from "./store/index.js";

const config = loadConfig();
const store = createStore(config);
const app = createApp(config, store);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `listening on :${info.port} (store=${config.storeBackend}, accessTtl=${config.accessTtl}s, rotateRefresh=${config.rotateRefresh})`,
  );
});
