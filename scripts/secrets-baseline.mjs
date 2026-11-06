const hash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function invalid(message) {
  throw new Error(`Invalid secrets baseline: ${message}`);
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}

export function findingKey(finding) {
  return JSON.stringify([
    finding.scope,
    finding.path,
    finding.rule,
    finding.line,
    finding.scope === "history" ? finding.commit : finding.blob,
  ]);
}

// Validate every exception, including ones that no longer match any finding.
export function validateBaseline(value, now = new Date()) {
  if (!exactKeys(value, ["version", "expires", "reason", "findings"]) || value.version !== 1) {
    invalid("expected version 1 and the documented fields");
  }
  if (typeof value.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.expires)) {
    invalid("expires must be a YYYY-MM-DD calendar date");
  }
  const deadline = new Date(`${value.expires}T00:00:00.000Z`);
  if (
    !Number.isFinite(deadline.getTime()) ||
    deadline.toISOString().slice(0, 10) !== value.expires
  ) {
    invalid("expires is not a real calendar date");
  }
  if (now.toISOString().slice(0, 10) > value.expires) invalid("exceptions have expired");
  if (typeof value.reason !== "string" || value.reason.trim().length < 30) {
    invalid("a substantive human risk-acceptance reason is required");
  }
  if (!Array.isArray(value.findings)) invalid("findings must be an array");
  const keys = new Set();
  for (const finding of value.findings) {
    const identity = finding?.scope === "history" ? "commit" : "blob";
    if (
      !exactKeys(finding, ["scope", "path", "rule", "line", identity]) ||
      !["history", "snapshot"].includes(finding.scope) ||
      typeof finding.path !== "string" ||
      !finding.path ||
      finding.path.startsWith("/") ||
      finding.path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof finding.rule !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(finding.rule) ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1 ||
      typeof finding[identity] !== "string" ||
      !hash.test(finding[identity])
    ) {
      invalid("a finding must have an exact path, rule, positive line and Git identity");
    }
    const key = findingKey(finding);
    if (keys.has(key)) invalid("duplicate finding");
    keys.add(key);
  }
  return keys;
}

export function validateReport(value, status, diagnostics) {
  if (!Array.isArray(value)) throw new Error("Scanner did not produce a JSON findings array");
  if ((status !== 0 && status !== 1) || (status === 1) !== value.length > 0) {
    throw new Error("Scanner exit status does not match its findings report");
  }
  // Betterleaks emits this one expected warning for a nonempty report. All
  // other warnings/errors (including partial scans) are fatal; never echo them.
  const lines = diagnostics.trim().split(/\r?\n/).filter(Boolean);
  if (
    (value.length === 0 && lines.length !== 0) ||
    lines.some((line) => !new RegExp(`^(?:\\S+ )?WRN leaks found: ${value.length}$`).test(line)) ||
    (value.length > 0 && lines.length !== 1)
  ) {
    throw new Error(
      "Scanner reported unexpected diagnostics; scan completeness is not established",
    );
  }
  for (const finding of value) {
    if (
      !finding ||
      typeof finding.File !== "string" ||
      !finding.File ||
      typeof finding.RuleID !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(finding.RuleID) ||
      !Number.isSafeInteger(finding.StartLine) ||
      finding.StartLine < 1 ||
      typeof finding.Commit !== "string" ||
      (finding.Commit && !hash.test(finding.Commit))
    ) {
      throw new Error("Scanner report contains an incomplete finding");
    }
  }
  return value;
}
