// Deploys the commit that is on GitHub's main to the "harmony" service on Railway, and waits
// until the service says it started and reconnected to WhatsApp.
//   node ~/harmony/scripts/desplegar.mjs
// Reads RAILWAY_API_TOKEN from ~/.harmony.env. Prints no secrets.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENVIRONMENT = "30f612ed-4a94-4bbc-a62f-6bc509b2e3c5"; // production
const SERVICE = "b4d22e1c-f7b0-4da3-bb1e-9b44269ec170"; // harmony

const settings = Object.fromEntries(
  readFileSync(join(homedir(), ".harmony.env"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

async function railway(query) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Project-Access-Token": settings.RAILWAY_API_TOKEN },
    body: JSON.stringify({ query }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors.map((error) => error.message).join("; "));
  return body.data;
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("fetch", "--quiet", "origin");
const commit = git("rev-parse", "origin/main");
console.log(`Desplegando ${commit.slice(0, 7)}: ${git("log", "-1", "--format=%s", commit)}`);

const { serviceInstanceDeployV2: deployment } = await railway(
  `mutation { serviceInstanceDeployV2(environmentId: "${ENVIRONMENT}", serviceId: "${SERVICE}", commitSha: "${commit}") }`,
);

let status = "";
for (let i = 0; i < 60; i++) {
  const { deployment: current } = await railway(`{ deployment(id: "${deployment}") { status } }`);
  if (current.status !== status) console.log(`  ${(status = current.status)}`);
  if (!/BUILDING|INITIALIZING|QUEUED|WAITING|DEPLOYING/.test(status)) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (status !== "SUCCESS") {
  console.error("El despliegue no terminó bien. La versión anterior sigue en servicio si Railway no la reemplazó.");
  process.exit(1);
}

// The service prints its own steps; wait for the one that says WhatsApp is back.
const wanted = /WhatsApp conectado|sigue sin conectar|Error no atrapado|Promesa rechazada|La casa está vacía/;
for (let i = 0; i < 30; i++) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const { deploymentLogs } = await railway(`{ deploymentLogs(deploymentId: "${deployment}", limit: 200) { message } }`);
  const line = deploymentLogs.map((entry) => entry.message).find((message) => wanted.test(message));
  if (line) {
    console.log(`Servicio: ${line.replace(/^\S+Z /, "")}`);
    process.exit(/WhatsApp conectado/.test(line) ? 0 : 1);
  }
}
console.log("Desplegado, pero el servicio todavía no dice que WhatsApp esté conectado. Revisa la bitácora en Railway.");
