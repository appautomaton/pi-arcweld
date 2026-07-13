import { ToolError } from "./response.js";

const states = new WeakMap();
const TARGET = /^s(\d+)_((?:f\d+)?e\d+)$/;
const INTERNAL_REF = /\[ref=((?:f\d+)?e\d+)\]/g;

function stateFor(page) {
  let state = states.get(page);
  if (!state) {
    state = { generation: 0, snapshotId: undefined, refs: new Map() };
    states.set(page, state);
  }
  return state;
}

export function publishSnapshot(page, ariaSnapshot, maxChars) {
  const state = stateFor(page);
  state.generation += 1;
  state.snapshotId = `s${state.generation}`;
  const scopedSnapshot = ariaSnapshot.replace(INTERNAL_REF, (_match, internalRef) => `[ref=${state.snapshotId}_${internalRef}]`);
  const boundedSnapshot = maxChars === undefined ? scopedSnapshot : scopedSnapshot.slice(0, maxChars);
  state.refs = new Map();
  const publishedTarget = /\[ref=(s\d+_((?:f\d+)?e\d+))\]/g;
  for (const match of boundedSnapshot.matchAll(publishedTarget)) state.refs.set(match[1], match[2]);
  return {
    ariaSnapshot: boundedSnapshot,
    snapshotId: state.snapshotId,
    refCount: state.refs.size,
    referenceScope: "session",
  };
}

export function stripSnapshotRefs(ariaSnapshot) {
  return ariaSnapshot.replace(/ \[ref=(?:f\d+)?e\d+\]/g, "");
}

export function resolveTarget(page, target) {
  const state = states.get(page);
  if (!state?.snapshotId) {
    throw new ToolError("SNAPSHOT_REQUIRED", "No active session snapshot is available for target resolution.", {
      retryable: true,
      suggestion: "Capture a fresh session snapshot, then use a target from that snapshot.",
    });
  }
  const match = TARGET.exec(target);
  if (!match) {
    throw new ToolError("INVALID_TARGET", `Invalid snapshot target: ${target}`, {
      retryable: true,
      suggestion: "Use an exact target returned by the latest session snapshot.",
    });
  }
  const targetSnapshotId = `s${match[1]}`;
  if (targetSnapshotId !== state.snapshotId) {
    throw new ToolError("STALE_TARGET", `Target ${target} belongs to snapshot ${targetSnapshotId}; the active snapshot is ${state.snapshotId}.`, {
      retryable: true,
      suggestion: "Capture a fresh session snapshot and use one of its targets.",
    });
  }
  const internalRef = state.refs.get(target);
  if (!internalRef) {
    throw new ToolError("INVALID_TARGET", `Target ${target} was not published by the active snapshot.`, {
      retryable: true,
      suggestion: "Use an exact target returned by the latest session snapshot.",
    });
  }
  return internalRef;
}

export function invalidateSnapshot(page) {
  const state = states.get(page);
  if (!state) return;
  state.snapshotId = undefined;
  state.refs = new Map();
}

export function snapshotState(page) {
  const state = states.get(page);
  return state ? { generation: state.generation, snapshotId: state.snapshotId, refCount: state.refs.size } : { generation: 0, snapshotId: undefined, refCount: 0 };
}
