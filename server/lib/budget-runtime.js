/**
 * Mid-run budget enforcement.
 * Tracks estimated + actual USD during a live run and signals when to kill.
 */
import { DEFAULT_COST_PER_TURN_USD, getBudgetStatus } from "./budget.js";

/**
 * Create a per-run budget tracker.
 * @param {{ dataDir: string, maxBudgetUsd?: number|null, sessionId?: string|null, costPerTurn?: number, daySpentTtlMs?: number }} opts
 */
export function createRunBudgetTracker({
  dataDir,
  maxBudgetUsd,
  sessionId,
  costPerTurn = DEFAULT_COST_PER_TURN_USD,
  daySpentTtlMs = 1000,
} = {}) {
  const cap =
    maxBudgetUsd != null && maxBudgetUsd !== ""
      ? Number(maxBudgetUsd)
      : null;
  let turnCount = 0;
  let actualCostUsd = null;
  let killed = false;
  let killReason = null;

  // Re-parsing the whole ledger from disk on every streamed tool event is a
  // sync read per event. Cache briefly instead — short enough that spend
  // recorded by a concurrent run still counts against this run's cap.
  let cachedDaySpent = 0;
  let cachedAt = -Infinity;

  function daySpent(now = Date.now()) {
    if (now - cachedAt < daySpentTtlMs) return cachedDaySpent;
    const st = getBudgetStatus(dataDir, {
      maxBudgetUsd: cap,
      sessionId: sessionId || null,
    });
    cachedDaySpent = st.spentUsd || 0;
    cachedAt = now;
    return cachedDaySpent;
  }

  function estimatedRunCost() {
    if (actualCostUsd != null) return actualCostUsd;
    return costPerTurn * Math.max(1, turnCount);
  }

  function projectedTotal() {
    return daySpent() + estimatedRunCost();
  }

  function status() {
    return {
      cap,
      turnCount,
      actualCostUsd,
      estimatedRunCostUsd: estimatedRunCost(),
      daySpentUsd: daySpent(),
      projectedTotalUsd: projectedTotal(),
      remainingUsd:
        cap != null && Number.isFinite(cap)
          ? Math.max(0, cap - daySpent() - estimatedRunCost())
          : null,
      killed,
      killReason,
    };
  }

  /**
   * Record a tool turn (tool_call). Returns { allow, reason }.
   */
  function onTurn() {
    turnCount += 1;
    return check();
  }

  /**
   * Record actual cost from an `end` event when present.
   */
  function onActualCost(costUsd) {
    if (costUsd == null || !Number.isFinite(Number(costUsd))) return check();
    actualCostUsd = Number(costUsd);
    return check();
  }

  function check() {
    if (killed) {
      return { allow: false, reason: killReason, ...status() };
    }
    if (cap == null || !Number.isFinite(cap)) {
      return { allow: true, reason: null, ...status() };
    }
    // Allow the first turn always so a run can start; kill once projection exceeds
    const projected = daySpent() + estimatedRunCost();
    if (projected > cap && turnCount > 0) {
      killed = true;
      killReason = `Mid-run budget exceeded: day $${daySpent().toFixed(4)} + run est $${estimatedRunCost().toFixed(4)} > cap $${cap.toFixed(2)}`;
      return { allow: false, reason: killReason, ...status() };
    }
    return { allow: true, reason: null, ...status() };
  }

  return {
    onTurn,
    onActualCost,
    check,
    status,
    get turnCount() {
      return turnCount;
    },
    get killed() {
      return killed;
    },
    get killReason() {
      return killReason;
    },
  };
}

/**
 * Extract cost from a streaming-json / end event if present.
 */
export function costFromEndEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.total_cost_usd != null && Number.isFinite(Number(evt.total_cost_usd))) {
    return Number(evt.total_cost_usd);
  }
  if (evt.usage?.total_cost_usd != null) {
    return Number(evt.usage.total_cost_usd);
  }
  return null;
}
