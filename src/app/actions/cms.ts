"use server";

/**
 * CMS editor server actions.
 *
 * - `saveCmsFields(cmsId, formData)` — merge form entries into the
 *   draft node's default config (the `match: {}` config), creating
 *   the config or node if missing. Returns an invalidate directive
 *   targeting the edited Partial so the preview refetches in place.
 * - `publishCmsDraft()` — copy every draft entry into published,
 *   clear the draft file. Invalidates the whole page so the editor
 *   re-reads both stores.
 */

import {
  lookupCmsNode,
  publishDraft,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
} from "../../framework/cms-runtime.ts";

export async function saveCmsFields(
  cmsId: string,
  configIndex: number,
  formData: FormData,
): Promise<{ invalidate: { selector: string } }> {
  const existing: CmsNode = lookupCmsNode(cmsId) ?? {
    id: cmsId,
    configs: [],
  };
  // Clone so we don't mutate the cached node shape.
  const node: CmsNode = {
    ...existing,
    id: cmsId,
    configs: existing.configs.map((c) => ({
      match: { ...c.match },
      fields: { ...c.fields },
    })),
    slots: existing.slots,
  };

  // Index resolution: configIndex < 0 is "find or create the default
  // (match: {}) config" — used by the UI when no explicit config is
  // selected. A non-negative index targets that slot in `node.configs`,
  // creating entries up to that slot if the node was freshly made.
  let target: CmsConfig;
  if (configIndex < 0) {
    let existing = node.configs.find(
      (c) => Object.keys(c.match).length === 0,
    );
    if (!existing) {
      existing = { match: {}, fields: {} };
      node.configs.push(existing);
    }
    target = existing;
  } else if (configIndex < node.configs.length) {
    target = node.configs[configIndex];
  } else {
    target = { match: {}, fields: {} };
    node.configs.push(target);
  }

  for (const [key, raw] of formData.entries()) {
    if (key.startsWith("__")) continue; // editor-internal fields
    const value = raw;
    if (typeof value === "string") {
      const kind = formData.get(`__kind:${key}`);
      if (kind === "number") {
        const n = Number(value);
        target.fields[key] = Number.isFinite(n) ? n : 0;
      } else if (kind === "boolean") {
        target.fields[key] = value === "on" || value === "true";
      } else {
        target.fields[key] = value;
      }
    }
  }

  // HTML checkboxes only appear in formData when checked — so any
  // boolean field declared on the form but missing from formData is
  // "false". The form emits `__boolean-fields=<name1>,<name2>`.
  const booleanFields = (formData.get("__boolean-fields") ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of booleanFields) {
    if (!formData.has(name)) {
      target.fields[name] = false;
    }
  }

  writeDraftNode(cmsId, node);
  return { invalidate: { selector: `#${cmsId}` } };
}

export async function publishCmsDraft(): Promise<{
  invalidate: { selector: string };
}> {
  publishDraft();
  // Blunt: invalidate the editor page so the tree rebuilds from the
  // updated stores. A future iteration could target only the
  // previously-drafted ids.
  return { invalidate: { selector: "#cms-edit-tree" } };
}
