export function createLogger(prefix = "grok-studio") {
  const ts = () => new Date().toISOString();
  return {
    info: (...args) => console.log(`[${ts()}] [${prefix}]`, ...args),
    warn: (...args) => console.warn(`[${ts()}] [${prefix}]`, ...args),
    error: (...args) => console.error(`[${ts()}] [${prefix}]`, ...args),
  };
}
