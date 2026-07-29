import fs from "fs";
import path from "path";

export function loadCatalog(catalogPath) {
  const raw = fs.readFileSync(catalogPath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.workflows)) {
    throw new Error(`catalog missing workflows array: ${catalogPath}`);
  }
  for (const w of data.workflows) {
    if (!w.id || !w.name || !w.promptTemplate) {
      throw new Error(`invalid workflow entry: ${JSON.stringify(w.id)}`);
    }
  }
  return data;
}

export function listRhaiWorkflows(dirs) {
  const found = [];
  const seen = new Set();
  for (const { dir, scope } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".rhai")) continue;
      const id = name.replace(/\.rhai$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      const full = path.join(dir, name);
      const text = fs.readFileSync(full, "utf8").slice(0, 4000);
      const m = text.match(/description\s*:\s*"([^"]+)"/);
      found.push({
        name: id,
        path: full,
        scope,
        description: m ? m[1] : "",
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
