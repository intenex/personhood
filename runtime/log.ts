import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./util.ts";

let logFile: string | null = null;

export function setLogDir(dir: string): void {
  ensureDir(dir);
  logFile = path.join(dir, "heartbeat.log");
}

/** Log a line. Keep content out of logs: they're for operations, not thoughts. */
export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  process.stdout.write(line + "\n");
  if (logFile) fs.appendFileSync(logFile, line + "\n");
}
