// Preview the built site locally at http://localhost:4173/personhood/ (run `npm run build:site` first).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "_site");
const base = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "site.json"), "utf8")).basePath ?? "/personhood";
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".jsonl": "application/x-ndjson" };
const port = Number(process.env.PORT ?? 4173);

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (!url.startsWith(base)) {
      res.writeHead(302, { Location: `${base}/` }).end();
      return;
    }
    let file = path.join(root, url.slice(base.length));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": types[".html"] }).end(fs.readFileSync(path.join(root, "404.html")));
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  })
  .listen(port, () => console.log(`serving ${root} at http://localhost:${port}${base}/`));
