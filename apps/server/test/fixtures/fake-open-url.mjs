import { appendFileSync } from "node:fs";

const capture = process.env.FAKE_OPEN_CAPTURE;
if (capture) appendFileSync(capture, `${process.argv[2] ?? ""}\n`);
