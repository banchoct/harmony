#!/bin/sh
# Saves the Supabase connection string in ~/.harmony.env without showing it.
# Asks for the string as Supabase shows it and for the database password, puts the password
# in its place, and adds verified TLS. Nothing typed here is printed or kept in the history.
set -eu
# If this is interrupted while the typing is hidden, show typing again.
trap 'stty echo 2>/dev/null || true' EXIT
printf 'Pega la cadena de conexión de Supabase y da Enter (o solo Enter para conservar la ya guardada): '
stty -echo 2>/dev/null || true; IFS= read -r CADENA; stty echo 2>/dev/null || true; echo
printf 'Pega la contraseña de la base de datos y da Enter: '
stty -echo 2>/dev/null || true; IFS= read -r CLAVE; stty echo 2>/dev/null || true; echo
CADENA="$CADENA" CLAVE="$CLAVE" node -e '
const fs = require("fs"), path = require("path"), os = require("os");
const file = path.join(os.homedir(), ".harmony.env");
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const saved = lines.find((l) => l.startsWith("DATABASE_URL="));
let raw = process.env.CADENA.trim();
const password = process.env.CLAVE.trim();
if (!password) { console.error("Faltó la contraseña."); process.exit(1); }
// Enter alone on the first question reuses the address already saved and changes only the password.
if (!raw && saved) raw = saved.slice("DATABASE_URL=".length);
if (!/^postgres(ql)?:\/\//.test(raw)) { console.error("Eso no parece una cadena de conexión: debe empezar con postgresql://"); process.exit(1); }
// Whatever stands where the password goes (the placeholder or an old password) is replaced.
const url = new URL(raw.replace(/\[YOUR-[A-Z-]*PASSWORD\]/, "x"));
const address = url.protocol + "//" + url.username + ":" + encodeURIComponent(password) + "@" + url.host + url.pathname + "?sslmode=require";
fs.writeFileSync(file, [...lines.filter((l) => !l.startsWith("DATABASE_URL=")), "DATABASE_URL=" + address].join("\n") + "\n", { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log("Guardada. Servidor: " + url.hostname + ", puerto " + (url.port || "5432") + ".");
'
