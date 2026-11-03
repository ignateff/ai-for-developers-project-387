import { existsSync } from "node:fs";
import { buildApp } from "../src/app.js";
const marker = process.argv[3];
let held = false;
const app = buildApp({
  onBookingLocked: marker
    ? () => {
        if (held) return;
        held = true;
        process.send?.({ locked: true });
        const latch = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(marker)) Atomics.wait(latch, 0, 0, 10);
      }
    : undefined,
  databasePath: process.argv[2],
  now: () => Date.parse("2026-10-30T08:00:00Z"),
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.on("message", async (message: { payload: object; key: string }) => {
  const response = await fetch(`${address}/api/bookings`, {
    method: "POST",
    body: JSON.stringify(message.payload),
    headers: { "content-type": "application/json", "idempotency-key": message.key },
  });
  process.send?.({ status: response.status, body: await response.json() });
});
process.send?.({ ready: true });
