/**
 * 权限预设 → ACP config option。宿主命令 `/permission`（dsh-permission-presets），
 * 经 commands/execute 调用；投影 permissions.currentValue 是权威状态。
 */

export const PERMISSION_CONFIG_ID = "permission";

const LABELS = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
  auto: "Auto",
};

/** 解析 `/permission` 无参输出：`current preset X (available: a, b, c)`。 */
export function parsePermissionOutput(text) {
  const match = /^current preset (\S+) \(available: ([^)]+)\)$/.exec((text ?? "").trim());
  if (!match) return null;
  const available = match[2].split(",").map((name) => name.trim()).filter(Boolean);
  if (available.length === 0) return null;
  return { current: match[1], available };
}

/** @param {{current: string, available: string[]} | null} state */
export function permissionOption(state) {
  if (!state) return null;
  return {
    id: PERMISSION_CONFIG_ID,
    name: "Permission",
    category: "permission",
    type: "select",
    currentValue: state.current,
    options: state.available.map((name) => ({ value: name, name: LABELS[name] ?? name })),
  };
}
