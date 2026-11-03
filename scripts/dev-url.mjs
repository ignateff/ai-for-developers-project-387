import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("mise", ["daemons", "ls", "--json"], { encoding: "utf8" }));
const web = local.find((daemon) => daemon.name === "web" && daemon.status === "running");
const all = JSON.parse(execFileSync("pitchfork", ["list", "--json"], { encoding: "utf8" }));
const info = all.find((daemon) => daemon.id === web?.id);
const port = info?.active_port ?? info?.port?.[0];
if (!port) throw new Error("Cannot determine the web server port");
console.log(`http://127.0.0.1:${port}/`);
