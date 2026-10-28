/**
 * 模型目录与 ACP session config：把 web 的 modelCatalog / 投影翻成客户端可选的
 * `configOptions`，并把客户端选中项写回 `session/selectModel`。
 */
const MODEL_CONFIG_ID = "model";
const REASONING_CONFIG_ID = "reasoning_effort";
const PROVIDER_DEFAULT = "";

/** ACP 选择值。和官方 dsh-acp 一样，是 `JSON.stringify([provider, model])`。 */
export function modelValue(provider, model) {
  return JSON.stringify([provider, model]);
}

/**
 * 当前会话下一次请求会用的模型。投影里的 next 优先，否则上次用过的，再否则目录默认。
 * @param {object | null | undefined} catalog
 * @param {object | null | undefined} projection
 */
export function currentSelection(catalog, projection) {
  const recorded = projection?.values?.modelSelection;
  const selection = recorded?.next ?? recorded?.lastUsed ?? catalog?.default;
  if (!selection?.provider || !selection?.model) return null;
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

/**
 * @param {object | null | undefined} catalog
 * @param {object | null | undefined} selection
 */
export function configOptions(catalog, selection) {
  if (!catalog || !selection) return [];
  const groups = [];
  const known = new Set();
  for (const group of catalog.groups ?? []) {
    const options = [];
    for (const model of group.models ?? []) {
      const value = modelValue(group.id, model.id);
      known.add(value);
      // 同一个模型在多家 vendor 里都有，把 vendor 拼进 option 名字里让客户端下拉能区分。
      const providerLabel = group.name || group.id;
      options.push({
        value,
        name: `${model.name} (${providerLabel})`,
        ...(model.description ? { description: model.description } : {}),
      });
    }
    if (options.length > 0) groups.push({ group: group.id, name: group.name, options });
  }
  const currentValue = modelValue(selection.provider, selection.model);
  if (!known.has(currentValue)) {
    let group = groups.find((item) => item.group === selection.provider);
    if (!group) {
      group = { group: selection.provider, name: selection.provider, options: [] };
      groups.push(group);
    }
    group.options.unshift({
      value: currentValue,
      name: `${selection.model} (${selection.provider})`,
    });
  }
  const options = [{
    id: MODEL_CONFIG_ID,
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: groups,
  }];
  const model = findModel(catalog, selection);
  if (model?.reasoning?.efforts?.length) {
    const efforts = model.reasoning.efforts;
    const fallback = model.reasoning.defaultEffort ?? PROVIDER_DEFAULT;
    const current = selection.reasoningEffort ?? fallback;
    const knownEffort = current === PROVIDER_DEFAULT
      ? model.reasoning.defaultEffort == null
      : efforts.some((effort) => effort.id === current);
    options.push({
      id: REASONING_CONFIG_ID,
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: knownEffort ? current : fallback,
      options: [
        ...(model.reasoning.defaultEffort == null
          ? [{ value: PROVIDER_DEFAULT, name: "Provider default" }]
          : []),
        ...efforts.map((effort) => ({
          value: String(effort.id),
          name: effort.name,
          ...(effort.description ? { description: effort.description } : {}),
        })),
      ],
    });
  }
  return options;
}

/**
 * 把客户端选中的一项换成 `session/selectModel` 要的选择。换模型时不带旧的推理档位。
 * @param {object} catalog
 * @param {object | null} selection
 * @param {string} configId
 * @param {unknown} value
 */
export function applyConfig(catalog, selection, configId, value) {
  if (typeof value !== "string") throw new Error(`${configId} requires a select value`);
  if (!selection) throw new Error("this session has no model selection");
  if (configId === MODEL_CONFIG_ID) {
    const parsed = parseModelValue(value);
    const allowed = parsed && (catalogHas(catalog, parsed) || (
      parsed.provider === selection.provider && parsed.model === selection.model
    ));
    if (!allowed) throw new Error(`unknown model option: ${value}`);
    return { provider: parsed.provider, model: parsed.model };
  }
  if (configId === REASONING_CONFIG_ID) {
    const model = findModel(catalog, selection);
    const providerDefault = value === PROVIDER_DEFAULT && model?.reasoning?.defaultEffort == null;
    const known = model?.reasoning?.efforts?.some((effort) => effort.id === value) === true;
    if (!providerDefault && !known) {
      throw new Error(`unknown reasoning effort for ${selection.provider}/${selection.model}: ${value}`);
    }
    return {
      provider: selection.provider,
      model: selection.model,
      ...(providerDefault ? {} : { reasoningEffort: value }),
    };
  }
  throw new Error(`unknown session config option: ${configId}`);
}

function parseModelValue(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    if (!parsed[0] || !parsed[1]) return null;
    return { provider: parsed[0], model: parsed[1] };
  } catch {
    return null;
  }
}

function catalogHas(catalog, selection) {
  return (catalog?.groups ?? []).some((group) => group.id === selection.provider
    && (group.models ?? []).some((model) => model.id === selection.model));
}

function findModel(catalog, selection) {
  const group = (catalog?.groups ?? []).find((item) => item.id === selection.provider);
  return group?.models?.find((model) => model.id === selection.model);
}
