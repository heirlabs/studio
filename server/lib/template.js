/**
 * Minimal Mustache-like renderer for workflow prompt templates.
 * Supports: {{var}} and {{#if images}}...{{/if}}
 */
export function renderTemplate(tpl, vars) {
  if (typeof tpl !== "string") {
    throw new TypeError("template must be a string");
  }
  let out = tpl;
  out = out.replace(
    /\{\{#if images\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, body) =>
      vars.images != null && String(vars.images).trim() ? body : "",
  );
  out = out.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => {
    if (!(key in vars)) return "";
    const v = vars[key];
    return v == null ? "" : String(v);
  });
  return out;
}

export function safeName(name) {
  const base = String(name || "file").trim() || "file";
  return base
    .replace(/\.\./g, "_")
    .replace(/[^\w.\-()+ ]+/g, "_")
    .slice(0, 120);
}
