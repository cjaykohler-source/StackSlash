import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// On-demand, read-only functions the dev server may run. Deliberately an
// allowlist: scan/scoring functions must never be reachable by opening a
// URL locally — a stray local scan once sent 5 real Discord alerts.
const DEV_FUNCTIONS = new Set(["session-candles", "session-bars", "quotes", "news"]);

/**
 * Dev only: serve GET /.netlify/functions/<name> by loading the function
 * through Vite and calling its default export, so the symbol page works
 * under `npm run dev` without the Netlify CLI. Server-side env (Alpaca,
 * Supabase service role) is read from .env into the dev server's process
 * only; it never reaches the client bundle, which still sees VITE_* vars.
 */
function netlifyFunctionsDev(): Plugin {
  return {
    name: "netlify-functions-dev",
    apply: "serve",
    configureServer(server) {
      const env = loadEnv("development", process.cwd(), "");
      for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;

      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/\.netlify\/functions\/([a-z0-9-]+)(\?.*)?$/);
        if (!match || req.method !== "GET") return next();
        if (!DEV_FUNCTIONS.has(match[1])) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: `${match[1]} is not enabled in the dev server` }));
          return;
        }
        try {
          const mod = await server.ssrLoadModule(`/netlify/functions/${match[1]}.ts`);
          const response: Response = await mod.default(new Request(`http://localhost${req.url}`));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(new Uint8Array(await response.arrayBuffer()));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), netlifyFunctionsDev()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
});
