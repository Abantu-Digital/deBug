#!/usr/bin/env node
// Usage: pnpm --filter @debug/dashboard hash-password [email]
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const email = process.argv[2] ?? (await ask("Email: "));
const password = await ask("Password (min 10 chars): ");
rl.close();
if (password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`\nAdd to DEBUG_DASHBOARD_USERS (comma-separate multiple users):\n\n${email.trim().toLowerCase()}=scrypt.${salt.toString("hex")}.${hash.toString("hex")}\n`);
