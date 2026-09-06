import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_NGROK_MODE ?? "ok";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const capture = process.env.FAKE_NGROK_CAPTURE;
if (capture) writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), authtoken: process.env.NGROK_AUTHTOKEN ?? null }));

emit({ lvl: "info", msg: "client session established" });
if (mode === "auth") {
  emit({ lvl: "eror", msg: "failed to start tunnel", err: "ERR_NGROK_4018 authentication failed: Usage of ngrok requires a verified account and authtoken." });
  process.stderr.write("ERROR:\n");
  process.exit(1);
}
const portIndex = process.argv.indexOf("http");
emit({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr: `http://localhost:${process.argv[portIndex + 1]}`, url: "https://fake.ngrok-free.app" });
setInterval(() => undefined, 1000);
