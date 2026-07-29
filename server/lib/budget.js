/**
 * Spending limits and turn accounting for agent runs.
 * Tracks estimated USD cost and turn counts per day / session.
 * Grok CLI does not expose --max-budget-usd; we enforce limits locally
 * before spawn and record estimates after completion.
 */
import fs from "fs";
import path from "path";

/** Default estimate per agent turn (USD) when no usage data arrives */
export const DEFAULT_COST_PER_TURN_USD = 0.05;

function ledgerPath(dataDir) {
  return path.join(dataDir, "budget-ledger.json");
}

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyLedger() {
  return {
    days: {},
    sessions: {},
    runs: {},
  };
}

export function loadLedger(dataDir) {
  const p = ledgerPath(dataDir);
  if (!fs.existsSync(p)) return emptyLedger();
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveLedger(dataDir, ledger) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ledgerPath(dataDir), JSON.stringify(ledger, null, 2));
}

function ensureDay(ledger, day) {
  if (!ledger.days[day]) {
    ledger.days[day] = { spentUsd: 0, turns: 0, runs: 0 };
  }
  return ledger.days[day];
}

function ensureSession(ledger, sessionId) {
  if (!ledger.sessions[sessionId]) {
    ledger.sessions[sessionId] = { spentUsd: 0, turns: 0, runs: 0 };
  }
  return ledger.sessions[sessionId];
}

/**
 * Check whether a new run is allowed under maxBudgetUsd / maxTurns.
 * maxBudgetUsd is daily hard limit when set.
 * maxTurns is per-run limit (passed to CLI); sessionMaxTurns optional.
 */
export function assertBudgetAllows(dataDir, {
  maxBudgetUsd,
  sessionId,
  sessionMaxTurns,
  estimatedTurns = 1,
  estimatedCostUsd,
} = {}) {
  const ledger = loadLedger(dataDir);
  const day = ensureDay(ledger, todayKey());
  const cost =
    estimatedCostUsd != null
      ? Number(estimatedCostUsd)
      : DEFAULT_COST_PER_TURN_USD * estimatedTurns;

  if (maxBudgetUsd != null && maxBudgetUsd !== "") {
    const cap = Number(maxBudgetUsd);
    if (Number.isFinite(cap) && day.spentUsd + cost > cap) {
      const err = new Error(
        `Daily budget exceeded: spent $${day.spentUsd.toFixed(4)} + est $${cost.toFixed(4)} > cap $${cap.toFixed(2)}`,
      );
      err.status = 429;
      err.code = "BUDGET_EXCEEDED";
      throw err;
    }
  }

  if (sessionId && sessionMaxTurns != null && sessionMaxTurns !== "") {
    const capTurns = Number(sessionMaxTurns);
    if (Number.isInteger(capTurns) && capTurns > 0) {
      const sess = ensureSession(ledger, sessionId);
      if (sess.turns + estimatedTurns > capTurns) {
        const err = new Error(
          `Session turn limit exceeded: ${sess.turns} + ${estimatedTurns} > ${capTurns}`,
        );
        err.status = 429;
        err.code = "TURNS_EXCEEDED";
        throw err;
      }
    }
  }

  return { ok: true, daySpentUsd: day.spentUsd, estimatedCostUsd: cost };
}

/**
 * Record a completed run's cost and turns.
 */
export function recordRunUsage(dataDir, {
  runId,
  sessionId,
  turns = 1,
  costUsd,
  status,
} = {}) {
  if (!runId) {
    const err = new Error("runId required");
    err.status = 400;
    throw err;
  }
  const ledger = loadLedger(dataDir);
  const day = ensureDay(ledger, todayKey());
  const cost =
    costUsd != null && Number.isFinite(Number(costUsd))
      ? Number(costUsd)
      : DEFAULT_COST_PER_TURN_USD * Math.max(1, turns);

  day.spentUsd = round4(day.spentUsd + cost);
  day.turns += Math.max(1, turns);
  day.runs += 1;

  if (sessionId) {
    const sess = ensureSession(ledger, sessionId);
    sess.spentUsd = round4(sess.spentUsd + cost);
    sess.turns += Math.max(1, turns);
    sess.runs += 1;
  }

  ledger.runs[runId] = {
    sessionId: sessionId || null,
    turns: Math.max(1, turns),
    costUsd: cost,
    status: status || null,
    at: Date.now(),
    day: todayKey(),
  };

  saveLedger(dataDir, ledger);
  return ledger.runs[runId];
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function getBudgetStatus(dataDir, { maxBudgetUsd, sessionId } = {}) {
  const ledger = loadLedger(dataDir);
  const day = ensureDay(ledger, todayKey());
  const sess = sessionId ? ensureSession(ledger, sessionId) : null;
  const cap =
    maxBudgetUsd != null && maxBudgetUsd !== ""
      ? Number(maxBudgetUsd)
      : null;
  return {
    day: todayKey(),
    spentUsd: day.spentUsd,
    turns: day.turns,
    runs: day.runs,
    maxBudgetUsd: cap,
    remainingUsd:
      cap != null && Number.isFinite(cap)
        ? Math.max(0, round4(cap - day.spentUsd))
        : null,
    session: sess
      ? {
          sessionId,
          spentUsd: sess.spentUsd,
          turns: sess.turns,
          runs: sess.runs,
        }
      : null,
  };
}
