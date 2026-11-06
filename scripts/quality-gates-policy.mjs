export function validateException(exception, now = new Date()) {
  const { reviewDate, reason } = exception;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate ?? "")) {
    throw new Error("Exception requires a YYYY-MM-DD reviewDate");
  }
  const date = new Date(`${reviewDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reviewDate) {
    throw new Error(`Invalid exception review date: ${reviewDate}`);
  }
  if (reviewDate < now.toISOString().slice(0, 10)) {
    throw new Error(`Exception review overdue: ${reviewDate}`);
  }
  if (typeof reason !== "string" || reason.trim().split(/\s+/).length < 5) {
    throw new Error("Exception requires a substantive reason");
  }
}
