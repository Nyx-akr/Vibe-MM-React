export const css = (source, scope) => {
  const resolved = source.replace(/\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g, (_, path) => {
    const parts = path.split('.'); let value = scope[parts.shift()];
    for (const p of parts) value = value == null ? '' : value[p];
    return value == null ? '' : String(value);
  });
  const out = {};
  for (const declaration of resolved.split(';')) {
    const i = declaration.indexOf(':'); if (i < 0) continue;
    const key = declaration.slice(0, i).trim(); const value = declaration.slice(i + 1).trim();
    if (!key) continue;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = value;
  }
  return out;
};

export default css;
