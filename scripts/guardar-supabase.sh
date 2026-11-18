#!/bin/sh
# Saves the Supabase connection string in ~/.harmony.env without showing it.
# Asks for the string as Supabase shows it and for the database password, puts the password
# in its place, and adds verified TLS. Nothing typed here is printed or kept in the history.
set -eu
printf 'Pega la cadena de conexión de Supabase y da Enter: '
stty -echo 2>/dev/null || true; IFS= read -r CADENA; stty echo 2>/dev/null || true; echo
printf 'Pega la contraseña de la base de datos y da Enter: '
stty -echo 2>/dev/null || true; IFS= read -r CLAVE; stty echo 2>/dev/null || true; echo
CADENA="$CADENA" CLAVE="$CLAVE" node -e '
const fs = require("fs"), path = require("path"), os = require("os");
let raw = process.env.CADENA.trim();
const password = process.env.CLAVE.trim();
if (!/^postgres(ql)?:\/\//.test(raw)) { console.error("Eso no parece una cadena de conexión: debe empezar con postgresql://"); process.exit(1); }
if (!password) { console.error("Faltó la contraseña."); process.exit(1); }
const placeholder = /\[YOUR-[A-Z-]*PASSWORD\]/;
if (!placeholder.test(raw)) { console.error("La cadena no trae el texto [YOUR-DATABASE-PASSWORD]. Cópiala otra vez de Supabase, tal como aparece."); process.exit(1); }
raw = raw.replace(placeholder, encodeURIComponent(password));
const url = new URL(raw);
url.searchParams.set("sslmode", "require");
const file = path.join(os.homedir(), ".harmony.env");
const kept = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("DATABASE_URL=")) : [];
fs.writeFileSync(file, [...kept, "DATABASE_URL=" + url.toString()].join("\n") + "\n", { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log("Guardada. Servidor: " + url.hostname + ", puerto " + (url.port || "5432") + ".");
'
