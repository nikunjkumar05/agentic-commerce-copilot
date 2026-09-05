// Parse a stored UTC timestamp and return it shifted to IST (UTC+05:30) wall
// clock, no matter which timezone the browser/server is in. `created_date` is
// TIMESTAMP (naive UTC): node-postgres serializes it to ISO UTC ("...Z"), so we
// treat it as UTC, shift +05:30, and format that wall-clock — fixing the old
// code that relabelled the local/UTC time as "IST" (off by 5:30 on any
// non-IST machine).
const IST_MS = 5 * 3600 * 1000 + 30 * 60 * 1000;

export const toIst = (raw) => {
  if (!raw) return null;
  const s = String(raw).replace(' ', 'T');
  const d = s.endsWith('Z') ? new Date(s) : new Date(s + 'Z');
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + IST_MS);
};
