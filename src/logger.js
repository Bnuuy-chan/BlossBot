// Tiny logger that prefixes every line with a timestamp, so host logs are easy to read.
function stamp() {
  return new Date().toISOString();
}

module.exports = {
  info: (...args) => console.log(`[${stamp()}] INFO`, ...args),
  warn: (...args) => console.warn(`[${stamp()}] WARN`, ...args),
  error: (...args) => console.error(`[${stamp()}] ERROR`, ...args),
};
