import type { DesignProfile } from "../../design-profile/types.js";
import { profilePathExists } from "../../design-profile/load.js";
import { loadHashedProfile } from "../../design-profile/lifecycle.js";
import { readManifest } from "../../design-generator/manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeClass = "additive" | "tightening" | "weakening" | "restructuring";

export interface DesignDiffChange {
  field: string;           // e.g. "ddd.contexts.billing.layers.domain"
  changeClass: ChangeClass;
  oldValue?: string;
  newValue?: string;
  requiresApproval: boolean;
  description: string;
}

export interface DesignDiffResult {
  changes: DesignDiffChange[];
  overallClass: ChangeClass; // most severe class present
  hasWeakening: boolean;
  hasRestructuring: boolean;
  requiresApproval: boolean;
}

export type DesignDiffOptions = {
  from?: string;
  json?: boolean;
};

// ---------------------------------------------------------------------------
// Severity ordering (higher = more severe)
// ---------------------------------------------------------------------------

const SEVERITY: Record<ChangeClass, number> = {
  additive: 0,
  tightening: 1,
  weakening: 2,
  restructuring: 3,
};

function maxClass(a: ChangeClass, b: ChangeClass): ChangeClass {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Field-level diff engine
// ---------------------------------------------------------------------------

/**
 * Compare two design profiles and classify changes at field level.
 */
export function computeDesignDiff(
  oldProfile: DesignProfile,
  newProfile: DesignProfile,
): DesignDiffResult {
  const changes: DesignDiffChange[] = [];

  compareContexts(oldProfile, newProfile, changes);
  compareIntegrations(oldProfile, newProfile, changes);
  compareSharedKernels(oldProfile, newProfile, changes);
  compareCoreInvariants(oldProfile, newProfile, changes);
  compareTypeDriven(oldProfile, newProfile, changes);
  compareToolchainContracts(oldProfile, newProfile, changes);
  compareProject(oldProfile, newProfile, changes);

  const overallClass = changes.length > 0
    ? changes.reduce((acc, c) => maxClass(acc, c.changeClass), "additive" as ChangeClass)
    : "additive";

  const hasWeakening = changes.some((c) => c.changeClass === "weakening");
  const hasRestructuring = changes.some((c) => c.changeClass === "restructuring");
  const requiresApproval = changes.some((c) => c.requiresApproval);

  return { changes, overallClass: overallClass as ChangeClass, hasWeakening, hasRestructuring, requiresApproval };
}

// ---------------------------------------------------------------------------
// Context comparison
// ---------------------------------------------------------------------------

function compareContexts(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldCtxs = old.ddd?.contexts ?? [];
  const newCtxs = newP.ddd?.contexts ?? [];

  const oldMap = new Map(oldCtxs.map((c) => [c.id, c]));
  const newMap = new Map(newCtxs.map((c) => [c.id, c]));

  const oldIds = new Set(oldMap.keys());
  const newIds = new Set(newMap.keys());

  // Added contexts
  for (const id of newIds) {
    if (!oldIds.has(id)) {
      const ctx = newMap.get(id)!;
      changes.push({
        field: `ddd.contexts.${id}`,
        changeClass: "additive",
        newValue: JSON.stringify({ id: ctx.id, name: ctx.name, root: ctx.root }),
        requiresApproval: true,
        description: `New bounded context added: "${ctx.name}" (id: ${ctx.id}, root: ${ctx.root})`,
      });
    }
  }

  // Removed contexts
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const ctx = oldMap.get(id)!;
      changes.push({
        field: `ddd.contexts.${id}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ id: ctx.id, name: ctx.name, root: ctx.root }),
        requiresApproval: true,
        description: `Bounded context removed: "${ctx.name}" (id: ${ctx.id})`,
      });
    }
  }

  // Modified contexts
  for (const id of newIds) {
    if (oldIds.has(id)) {
      const oldCtx = oldMap.get(id)!;
      const newCtx = newMap.get(id)!;

      // Root changed → restructuring
      if (oldCtx.root !== newCtx.root) {
        changes.push({
          field: `ddd.contexts.${id}.root`,
          changeClass: "restructuring",
          oldValue: oldCtx.root,
          newValue: newCtx.root,
          requiresApproval: true,
          description: `Context root moved for "${id}": ${oldCtx.root} → ${newCtx.root}`,
        });
      }

      // Layers comparison
      compareContextLayers(id, oldCtx.layers, newCtx.layers, changes);

      // Aggregate roots comparison
      compareAggregateRoots(id, oldCtx, newCtx, changes);
    }
  }
}

function compareContextLayers(
  contextId: string,
  oldLayers: Record<string, string | string[]>,
  newLayers: Record<string, string | string[]>,
  changes: DesignDiffChange[],
): void {
  const oldKeys = new Set(Object.keys(oldLayers));
  const newKeys = new Set(Object.keys(newLayers));

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      const val = serializeValue(newLayers[key]);
      changes.push({
        field: `ddd.contexts.${contextId}.layers.${key}`,
        changeClass: "additive",
        newValue: val,
        requiresApproval: true,
        description: `New layer added to context "${contextId}": ${key} = ${val}`,
      });
    }
  }

  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      const val = serializeValue(oldLayers[key]);
      changes.push({
        field: `ddd.contexts.${contextId}.layers.${key}`,
        changeClass: "weakening",
        oldValue: val,
        requiresApproval: true,
        description: `Layer removed from context "${contextId}": ${key}`,
      });
    }
  }

  for (const key of newKeys) {
    if (oldKeys.has(key)) {
      const oldVal = serializeValue(oldLayers[key]);
      const newVal = serializeValue(newLayers[key]);
      if (oldVal !== newVal) {
        changes.push({
          field: `ddd.contexts.${contextId}.layers.${key}`,
          changeClass: "restructuring",
          oldValue: oldVal,
          newValue: newVal,
          requiresApproval: true,
          description: `Layer pattern changed for context "${contextId}" layer "${key}": ${oldVal} → ${newVal}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregate root comparison
// ---------------------------------------------------------------------------

function compareAggregateRoots(
  contextId: string,
  oldCtx: { aggregate_roots?: Array<{ id: string; target: string; metrics: Record<string, { ideal?: number; max?: number }> }> },
  newCtx: { aggregate_roots?: Array<{ id: string; target: string; metrics: Record<string, { ideal?: number; max?: number }> }> },
  changes: DesignDiffChange[],
): void {
  const oldAggs = oldCtx.aggregate_roots ?? [];
  const newAggs = newCtx.aggregate_roots ?? [];

  const oldMap = new Map(oldAggs.map((a) => [a.id, a]));
  const newMap = new Map(newAggs.map((a) => [a.id, a]));

  const oldIds = new Set(oldMap.keys());
  const newIds = new Set(newMap.keys());

  // Added aggregates
  for (const id of newIds) {
    if (!oldIds.has(id)) {
      const agg = newMap.get(id)!;
      changes.push({
        field: `ddd.contexts.${contextId}.aggregate_roots.${id}`,
        changeClass: "additive",
        newValue: JSON.stringify({ id: agg.id, target: agg.target }),
        requiresApproval: true,
        description: `New aggregate root added in context "${contextId}": ${agg.id} (target: ${agg.target})`,
      });
    }
  }

  // Removed aggregates
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const agg = oldMap.get(id)!;
      changes.push({
        field: `ddd.contexts.${contextId}.aggregate_roots.${id}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ id: agg.id, target: agg.target }),
        requiresApproval: true,
        description: `Aggregate root removed from context "${contextId}": ${agg.id}`,
      });
    }
  }

  // Modified aggregates
  for (const id of newIds) {
    if (oldIds.has(id)) {
      const oldAgg = oldMap.get(id)!;
      const newAgg = newMap.get(id)!;

      // Target changed → restructuring
      if (oldAgg.target !== newAgg.target) {
        changes.push({
          field: `ddd.contexts.${contextId}.aggregate_roots.${id}.target`,
          changeClass: "restructuring",
          oldValue: oldAgg.target,
          newValue: newAgg.target,
          requiresApproval: true,
          description: `Aggregate target moved for "${id}" in context "${contextId}": ${oldAgg.target} → ${newAgg.target}`,
        });
      }

      // Metrics comparison
      compareAggregateMetrics(contextId, id, oldAgg.metrics, newAgg.metrics, changes);
    }
  }
}

function compareAggregateMetrics(
  contextId: string,
  aggId: string,
  oldMetrics: Record<string, { ideal?: number; max?: number }>,
  newMetrics: Record<string, { ideal?: number; max?: number }>,
  changes: DesignDiffChange[],
): void {
  const allMetricKeys = new Set([
    ...Object.keys(oldMetrics),
    ...Object.keys(newMetrics),
  ]);

  for (const metric of allMetricKeys) {
    const oldM = oldMetrics[metric];
    const newM = newMetrics[metric];
    const field = `ddd.contexts.${contextId}.aggregate_roots.${aggId}.metrics.${metric}`;

    if (!oldM && newM) {
      // New metric added → tightening
      changes.push({
        field,
        changeClass: "tightening",
        newValue: JSON.stringify(newM),
        requiresApproval: false,
        description: `New metric constraint added for "${aggId}" in "${contextId}": ${metric} = ${JSON.stringify(newM)}`,
      });
    } else if (oldM && !newM) {
      // Metric removed → weakening
      changes.push({
        field,
        changeClass: "weakening",
        oldValue: JSON.stringify(oldM),
        requiresApproval: true,
        description: `Metric constraint removed for "${aggId}" in "${contextId}": ${metric}`,
      });
    } else if (oldM && newM) {
      // Compare max values
      if (oldM.max !== undefined && newM.max !== undefined && oldM.max !== newM.max) {
        if (newM.max > oldM.max) {
          // Max increased → weakening (relaxed)
          changes.push({
            field: `${field}.max`,
            changeClass: "weakening",
            oldValue: String(oldM.max),
            newValue: String(newM.max),
            requiresApproval: true,
            description: `Metric max relaxed for "${aggId}" in "${contextId}" ${metric}: ${oldM.max} → ${newM.max}`,
          });
        } else {
          // Max decreased → tightening (stricter)
          changes.push({
            field: `${field}.max`,
            changeClass: "tightening",
            oldValue: String(oldM.max),
            newValue: String(newM.max),
            requiresApproval: false,
            description: `Metric max tightened for "${aggId}" in "${contextId}" ${metric}: ${oldM.max} → ${newM.max}`,
          });
        }
      }
      // Compare ideal values
      if (oldM.ideal !== undefined && newM.ideal !== undefined && oldM.ideal !== newM.ideal) {
        changes.push({
          field: `${field}.ideal`,
          changeClass: "tightening",
          oldValue: String(oldM.ideal),
          newValue: String(newM.ideal),
          requiresApproval: false,
          description: `Metric ideal changed for "${aggId}" in "${contextId}" ${metric}: ${oldM.ideal} → ${newM.ideal}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Integration comparison
// ---------------------------------------------------------------------------

function compareIntegrations(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldInts = old.ddd?.integrations ?? [];
  const newInts = newP.ddd?.integrations ?? [];

  const oldKeys = new Set(oldInts.map((i) => integrationKey(i)));
  const newKeys = new Set(newInts.map((i) => integrationKey(i)));

  // Added integrations
  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      const integ = newInts.find((i) => integrationKey(i) === key)!;
      changes.push({
        field: `ddd.integrations.${integ.from}→${integ.to}`,
        changeClass: "additive",
        newValue: JSON.stringify({ from: integ.from, to: integ.to, pattern: integ.pattern }),
        requiresApproval: true,
        description: `New integration added: ${integ.from} → ${integ.to} (pattern: ${integ.pattern})`,
      });
    }
  }

  // Removed integrations
  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      const integ = oldInts.find((i) => integrationKey(i) === key)!;
      changes.push({
        field: `ddd.integrations.${integ.from}→${integ.to}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ from: integ.from, to: integ.to, pattern: integ.pattern }),
        requiresApproval: true,
        description: `Integration removed: ${integ.from} → ${integ.to}`,
      });
    }
  }

  // Modified integration patterns → restructuring
  for (const key of newKeys) {
    if (oldKeys.has(key)) {
      const oldInteg = oldInts.find((i) => integrationKey(i) === key)!;
      const newInteg = newInts.find((i) => integrationKey(i) === key)!;
      if (oldInteg.pattern !== newInteg.pattern) {
        changes.push({
          field: `ddd.integrations.${oldInteg.from}→${oldInteg.to}.pattern`,
          changeClass: "restructuring",
          oldValue: oldInteg.pattern,
          newValue: newInteg.pattern,
          requiresApproval: true,
          description: `Integration pattern changed for ${oldInteg.from} → ${oldInteg.to}: ${oldInteg.pattern} → ${newInteg.pattern}`,
        });
      }
    }
  }
}

function integrationKey(i: { from: string; to: string }): string {
  return `${i.from}→${i.to}`;
}

// ---------------------------------------------------------------------------
// Shared kernel comparison
// ---------------------------------------------------------------------------

function compareSharedKernels(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldKernels = old.ddd?.shared_kernels ?? [];
  const newKernels = newP.ddd?.shared_kernels ?? [];

  const oldMap = new Map(oldKernels.map((k) => [k.id, k]));
  const newMap = new Map(newKernels.map((k) => [k.id, k]));

  const oldIds = new Set(oldMap.keys());
  const newIds = new Set(newMap.keys());

  for (const id of newIds) {
    if (!oldIds.has(id)) {
      const k = newMap.get(id)!;
      changes.push({
        field: `ddd.shared_kernels.${id}`,
        changeClass: "additive",
        newValue: JSON.stringify({ id: k.id, paths: k.paths }),
        requiresApproval: true,
        description: `New shared kernel added: ${id} (paths: ${JSON.stringify(k.paths)})`,
      });
    }
  }

  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const k = oldMap.get(id)!;
      changes.push({
        field: `ddd.shared_kernels.${id}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ id: k.id, paths: k.paths }),
        requiresApproval: true,
        description: `Shared kernel removed: ${id}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Core invariant comparison
// ---------------------------------------------------------------------------

function compareCoreInvariants(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldInvs = old.ddd?.core_invariants ?? [];
  const newInvs = newP.ddd?.core_invariants ?? [];

  const oldMap = new Map(oldInvs.map((i) => [i.id, i]));
  const newMap = new Map(newInvs.map((i) => [i.id, i]));

  const oldIds = new Set(oldMap.keys());
  const newIds = new Set(newMap.keys());

  // Added invariants
  for (const id of newIds) {
    if (!oldIds.has(id)) {
      const inv = newMap.get(id)!;
      // Pending invariant proposals → additive, no approval needed
      changes.push({
        field: `ddd.core_invariants.${id}`,
        changeClass: "additive",
        newValue: JSON.stringify({ id: inv.id, description: inv.description, status: inv.status }),
        requiresApproval: false,
        description: `New core invariant proposal added: "${inv.id}" (${inv.status})`,
      });
    }
  }

  // Removed invariants → weakening
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const inv = oldMap.get(id)!;
      changes.push({
        field: `ddd.core_invariants.${id}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ id: inv.id, description: inv.description, status: inv.status }),
        requiresApproval: true,
        description: `Core invariant removed: "${inv.id}"`,
      });
    }
  }

  // Modified invariants (status change, evolvability change)
  for (const id of newIds) {
    if (oldIds.has(id)) {
      const oldInv = oldMap.get(id)!;
      const newInv = newMap.get(id)!;

      if (oldInv.status !== newInv.status) {
        changes.push({
          field: `ddd.core_invariants.${id}.status`,
          changeClass: "tightening",
          oldValue: oldInv.status,
          newValue: newInv.status,
          requiresApproval: newInv.status === "pending",
          description: `Invariant status changed for "${id}": ${oldInv.status} → ${newInv.status}`,
        });
      }

      if (oldInv.evolvability !== newInv.evolvability) {
        changes.push({
          field: `ddd.core_invariants.${id}.evolvability`,
          changeClass: "tightening",
          oldValue: oldInv.evolvability,
          newValue: newInv.evolvability,
          requiresApproval: newInv.evolvability === "flexible",
          description: `Invariant evolvability changed for "${id}": ${oldInv.evolvability} → ${newInv.evolvability}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Type-driven section comparison
// ---------------------------------------------------------------------------

function compareTypeDriven(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldTd = old.type_driven;
  const newTd = newP.type_driven;

  if (!oldTd && newTd) {
    changes.push({
      field: "type_driven",
      changeClass: "additive",
      newValue: "enabled",
      requiresApproval: true,
      description: "Type-driven section enabled",
    });
  } else if (oldTd && newTd) {
    // enabled flag toggle
    if (oldTd.enabled !== newTd.enabled) {
      changes.push({
        field: "type_driven.enabled",
        changeClass: oldTd.enabled && !newTd.enabled ? "weakening" : "additive",
        oldValue: String(oldTd.enabled),
        newValue: String(newTd.enabled),
        requiresApproval: !newTd.enabled,
        description: `Type-driven ${newTd.enabled ? "enabled" : "disabled"}`,
      });
    }

    // Branded IDs
    compareBrandedIds(oldTd, newTd, changes);

    // ADT
    compareADT(oldTd, newTd, changes);

    // Smart constructors
    compareSmartConstructors(oldTd, newTd, changes);

    // Type state
    compareTypeState(oldTd, newTd, changes);

    // Runtime validation
    compareRuntimeValidation(oldTd, newTd, changes);
  } else if (oldTd && !newTd) {
    changes.push({
      field: "type_driven",
      changeClass: "weakening",
      oldValue: "enabled",
      requiresApproval: true,
      description: "Type-driven section removed entirely",
    });
  }
}

function compareBrandedIds(
  oldTd: NonNullable<DesignProfile["type_driven"]>,
  newTd: NonNullable<DesignProfile["type_driven"]>,
  changes: DesignDiffChange[],
): void {
  const oldIds = oldTd.branded_ids?.declarations ?? [];
  const newIds = newTd.branded_ids?.declarations ?? [];

  const oldMap = new Map(oldIds.map((b) => [b.id, b]));
  const newMap = new Map(newIds.map((b) => [b.id, b]));

  const oldSet = new Set(oldMap.keys());
  const newSet = new Set(newMap.keys());

  for (const id of newSet) {
    if (!oldSet.has(id)) {
      const b = newMap.get(id)!;
      // Branded ID with explicit target → additive, no approval (agent may propose)
      changes.push({
        field: `type_driven.branded_ids.${id}`,
        changeClass: "additive",
        newValue: JSON.stringify({ id: b.id, type_name: b.type_name, type_target: b.type_target }),
        requiresApproval: !b.type_target,
        description: `New branded ID declaration: ${b.id} (${b.type_name} → ${b.type_target})`,
      });
    }
  }

  for (const id of oldSet) {
    if (!newSet.has(id)) {
      const b = oldMap.get(id)!;
      changes.push({
        field: `type_driven.branded_ids.${id}`,
        changeClass: "weakening",
        oldValue: JSON.stringify({ id: b.id, type_name: b.type_name }),
        requiresApproval: true,
        description: `Branded ID declaration removed: ${b.id}`,
      });
    }
  }

  for (const id of newSet) {
    if (oldSet.has(id)) {
      const oldB = oldMap.get(id)!;
      const newB = newMap.get(id)!;
      if (oldB.type_name !== newB.type_name) {
        changes.push({
          field: `type_driven.branded_ids.${id}.type_name`,
          changeClass: "restructuring",
          oldValue: oldB.type_name,
          newValue: newB.type_name,
          requiresApproval: true,
          description: `Branded ID type name changed for "${id}": ${oldB.type_name} → ${newB.type_name}`,
        });
      }
      if (oldB.type_target !== newB.type_target) {
        changes.push({
          field: `type_driven.branded_ids.${id}.type_target`,
          changeClass: "restructuring",
          oldValue: oldB.type_target,
          newValue: newB.type_target,
          requiresApproval: true,
          description: `Branded ID target changed for "${id}": ${oldB.type_target} → ${newB.type_target}`,
        });
      }
    }
  }
}

function compareADT(
  oldTd: NonNullable<DesignProfile["type_driven"]>,
  newTd: NonNullable<DesignProfile["type_driven"]>,
  changes: DesignDiffChange[],
): void {
  const oldEntities = oldTd.adt?.entities ?? [];
  const newEntities = newTd.adt?.entities ?? [];

  const oldNames = new Set(oldEntities.map((e) => e.name));
  const newNames = new Set(newEntities.map((e) => e.name));
  const newMap = new Map(newEntities.map((e) => [e.name, e]));

  for (const name of newNames) {
    if (!oldNames.has(name)) {
      changes.push({
        field: `type_driven.adt.entities.${name}`,
        changeClass: "additive",
        newValue: newMap.get(name)!.type_target,
        requiresApproval: true,
        description: `New ADT entity: ${name}`,
      });
    }
  }

  for (const name of oldNames) {
    if (!newNames.has(name)) {
      changes.push({
        field: `type_driven.adt.entities.${name}`,
        changeClass: "weakening",
        requiresApproval: true,
        description: `ADT entity removed: ${name}`,
      });
    }
  }
}

function compareSmartConstructors(
  oldTd: NonNullable<DesignProfile["type_driven"]>,
  newTd: NonNullable<DesignProfile["type_driven"]>,
  changes: DesignDiffChange[],
): void {
  const oldVos = oldTd.smart_constructors?.value_objects ?? [];
  const newVos = newTd.smart_constructors?.value_objects ?? [];

  const oldMap = new Map(oldVos.map((s) => [s.id, s]));
  const newMap = new Map(newVos.map((s) => [s.id, s]));

  const oldIds = new Set(oldMap.keys());
  const newIds = new Set(newMap.keys());

  for (const id of newIds) {
    if (!oldIds.has(id)) {
      changes.push({
        field: `type_driven.smart_constructors.${id}`,
        changeClass: "additive",
        requiresApproval: true,
        description: `New smart constructor: ${id}`,
      });
    }
  }

  for (const id of oldIds) {
    if (!newIds.has(id)) {
      changes.push({
        field: `type_driven.smart_constructors.${id}`,
        changeClass: "weakening",
        requiresApproval: true,
        description: `Smart constructor removed: ${id}`,
      });
    }
  }
}

function compareTypeState(
  oldTd: NonNullable<DesignProfile["type_driven"]>,
  newTd: NonNullable<DesignProfile["type_driven"]>,
  changes: DesignDiffChange[],
): void {
  const oldMachines = oldTd.type_state?.state_machines ?? [];
  const newMachines = newTd.type_state?.state_machines ?? [];

  const oldNames = new Set(oldMachines.map((s) => s.name));
  const newNames = new Set(newMachines.map((s) => s.name));

  for (const name of newNames) {
    if (!oldNames.has(name)) {
      changes.push({
        field: `type_driven.type_state.state_machines.${name}`,
        changeClass: "additive",
        requiresApproval: true,
        description: `New type state machine: ${name}`,
      });
    }
  }

  for (const name of oldNames) {
    if (!newNames.has(name)) {
      changes.push({
        field: `type_driven.type_state.state_machines.${name}`,
        changeClass: "weakening",
        requiresApproval: true,
        description: `Type state machine removed: ${name}`,
      });
    }
  }
}

function compareRuntimeValidation(
  oldTd: NonNullable<DesignProfile["type_driven"]>,
  newTd: NonNullable<DesignProfile["type_driven"]>,
  changes: DesignDiffChange[],
): void {
  const oldTool = oldTd.runtime_validation?.tool;
  const newTool = newTd.runtime_validation?.tool;

  if (oldTool && !newTool) {
    changes.push({
      field: "type_driven.runtime_validation.tool",
      changeClass: "weakening",
      oldValue: oldTool,
      requiresApproval: true,
      description: `Runtime validation tool removed: ${oldTool}`,
    });
  } else if (!oldTool && newTool) {
    changes.push({
      field: "type_driven.runtime_validation.tool",
      changeClass: "tightening",
      newValue: newTool,
      requiresApproval: false,
      description: `Runtime validation tool added: ${newTool}`,
    });
  } else if (oldTool && newTool && oldTool !== newTool) {
    changes.push({
      field: "type_driven.runtime_validation.tool",
      changeClass: "restructuring",
      oldValue: oldTool,
      newValue: newTool,
      requiresApproval: true,
      description: `Runtime validation tool changed: ${oldTool} → ${newTool}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Toolchain contract comparison
// ---------------------------------------------------------------------------

function compareToolchainContracts(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldTc = old.toolchain_contracts;
  const newTc = newP.toolchain_contracts;

  if (!oldTc && !newTc) return;
  if (!oldTc && newTc) {
    changes.push({
      field: "toolchain_contracts",
      changeClass: "additive",
      newValue: "added",
      requiresApproval: true,
      description: "Toolchain contracts section added",
    });
    return;
  }
  if (oldTc && !newTc) {
    changes.push({
      field: "toolchain_contracts",
      changeClass: "weakening",
      oldValue: "present",
      requiresApproval: true,
      description: "Toolchain contracts section removed entirely",
    });
    return;
  }

  // TypeScript diagnostics
  const oldTsDiag = oldTc?.typescript_diagnostics;
  const newTsDiag = newTc?.typescript_diagnostics;
  if (oldTsDiag?.enabled !== newTsDiag?.enabled) {
    changes.push({
      field: "toolchain_contracts.typescript_diagnostics.enabled",
      changeClass: oldTsDiag?.enabled && !newTsDiag?.enabled ? "weakening" : "tightening",
      oldValue: String(oldTsDiag?.enabled ?? false),
      newValue: String(newTsDiag?.enabled ?? false),
      requiresApproval: !newTsDiag?.enabled,
      description: `TypeScript diagnostics ${newTsDiag?.enabled ? "enabled" : "disabled"}`,
    });
  }

  // ESLint
  const oldEs = oldTc?.eslint;
  const newEs = newTc?.eslint;
  if (oldEs?.enabled !== newEs?.enabled) {
    changes.push({
      field: "toolchain_contracts.eslint.enabled",
      changeClass: oldEs?.enabled && !newEs?.enabled ? "weakening" : "tightening",
      oldValue: String(oldEs?.enabled ?? false),
      newValue: String(newEs?.enabled ?? false),
      requiresApproval: !newEs?.enabled,
      description: `ESLint ${newEs?.enabled ? "enabled" : "disabled"}`,
    });
  }

  // ESLint rules
  if (oldEs?.rules && newEs?.rules) {
    const oldRules = new Set(oldEs.rules);
    const newRules = new Set(newEs.rules);

    for (const rule of newRules) {
      if (!oldRules.has(rule)) {
        changes.push({
          field: `toolchain_contracts.eslint.rules.${rule}`,
          changeClass: "tightening",
          newValue: rule,
          requiresApproval: false,
          description: `ESLint rule added: ${rule}`,
        });
      }
    }

    for (const rule of oldRules) {
      if (!newRules.has(rule)) {
        changes.push({
          field: `toolchain_contracts.eslint.rules.${rule}`,
          changeClass: "weakening",
          oldValue: rule,
          requiresApproval: true,
          description: `ESLint rule removed: ${rule}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Project section comparison
// ---------------------------------------------------------------------------

function compareProject(
  old: DesignProfile,
  newP: DesignProfile,
  changes: DesignDiffChange[],
): void {
  const oldProj = old.project;
  const newProj = newP.project;
  if (!oldProj || !newProj) return;

  // Source roots
  const oldRoots = new Set(oldProj.source_roots);
  const newRoots = new Set(newProj.source_roots);

  for (const root of newRoots) {
    if (!oldRoots.has(root)) {
      changes.push({
        field: `project.source_roots.${root}`,
        changeClass: "additive",
        newValue: root,
        requiresApproval: true,
        description: `Source root added: ${root}`,
      });
    }
  }

  for (const root of oldRoots) {
    if (!newRoots.has(root)) {
      changes.push({
        field: `project.source_roots.${root}`,
        changeClass: "weakening",
        oldValue: root,
        requiresApproval: true,
        description: `Source root removed: ${root}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeValue(val: string | string[]): string {
  if (Array.isArray(val)) return JSON.stringify(val);
  return val;
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export async function runDesignDiff(
  opts: DesignDiffOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  const result = await diffDesign(opts, projectDir);
  const out = opts.json ? JSON.stringify(result, null, 2) : formatDiff(result);
  process.stdout.write(out + "\n");
}

async function diffDesign(_opts: DesignDiffOptions, projectDir: string): Promise<DesignDiffResult> {
  if (!profilePathExists(projectDir)) {
    return {
      changes: [],
      overallClass: "additive",
      hasWeakening: false,
      hasRestructuring: false,
      requiresApproval: false,
    };
  }

  // Closeout 4: typed DESIGN_PROFILE_LIFECYCLE chain.
  const currentProfile = loadHashedProfile(projectDir).profile;
  const manifest = readManifest(projectDir);

  // If there's a manifest with a stored profile, we can try to load the old profile
  // For now, if no baseline profile is available, diff against an empty-ish profile
  if (!manifest) {
    // No manifest means no previous baseline. Compare against a minimal profile.
    const emptyProfile: DesignProfile = {
      schema_version: currentProfile.schema_version,
      kind: currentProfile.kind,
      profile_id: currentProfile.profile_id,
      created_at: currentProfile.created_at,
      updated_at: currentProfile.updated_at,
      project: {
        language: currentProfile.project.language,
        source_roots: [],
        ignore: [],
      },
    };
    return computeDesignDiff(emptyProfile, currentProfile);
  }

  // We don't have the old profile content stored in the manifest.
  // The manifest only stores the hash. Return a minimal diff result.
  // In practice, the caller should supply the old profile via the `from` option.
  return {
    changes: [],
    overallClass: "additive",
    hasWeakening: false,
    hasRestructuring: false,
    requiresApproval: false,
  };
}

function formatDiff(result: DesignDiffResult): string {
  const lines: string[] = [];

  lines.push("Design diff:");
  lines.push(`  Overall class: ${result.overallClass}`);
  lines.push(`  Requires approval: ${result.requiresApproval}`);
  lines.push(`  Has weakening: ${result.hasWeakening}`);
  lines.push(`  Has restructuring: ${result.hasRestructuring}`);

  if (result.changes.length === 0) {
    lines.push("  No changes detected.");
  } else {
    lines.push(`  Changes (${result.changes.length}):`);
    for (const change of result.changes) {
      const approvalTag = change.requiresApproval ? " [APPROVAL REQUIRED]" : "";
      lines.push(`    [${change.changeClass}] ${change.field}:${approvalTag}`);
      lines.push(`      ${change.description}`);
      if (change.oldValue) lines.push(`      Old: ${change.oldValue}`);
      if (change.newValue) lines.push(`      New: ${change.newValue}`);
    }
  }

  return lines.join("\n");
}
