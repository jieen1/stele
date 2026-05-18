import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import type {
  ArchitectureDeclaration,
  ArchitectureModuleDeclaration,
  ArchitectureLayerDeclaration,
  ArchitectureAllowDependencyDeclaration,
} from "./structure-types.js";
import { validationError } from "./structure-error.js";
import { readSingleExpression, ensureFieldUnset, readSingleString } from "./structure-shared.js";

const CODE = "E0323";

export function parseArchitectureDeclaration(filePath: string, node: ListNode): ArchitectureDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE,
      "Architecture declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the architecture id.",
      'Use a form like (architecture "my-architecture" ...).',
    );
  }

  const id = idNode.value;
  let lang: string | undefined;
  let tsconfig: string | undefined;
  let description: string | undefined;
  let denyCycles = true; // default to true
  let hasSeenDenyCycles: boolean | undefined = undefined; // tracker for ensureFieldUnset
  let fix: string | undefined;
  const modules: ArchitectureModuleDeclaration[] = [];
  const layers: ArchitectureLayerDeclaration[] = [];
  const allowDependencies: ArchitectureAllowDependencyDeclaration[] = [];
  const moduleIds = new Set<string>();
  const layerIds = new Set<string>();

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE,
        `Architecture "${id}" contains an unsupported field entry.`,
        item.span,
        "Architecture fields must be nested list forms such as (lang ...), (module ...), or (allow-dependency ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "lang": {
        ensureFieldUnset(lang, "lang", `Architecture "${id}" lang`, CODE, item.span);
        lang = readSingleString(item, `Architecture "${id}" lang`, CODE);
        if (lang !== "typescript") {
          throw validationError(
            CODE,
            `Architecture "${id}" has an unsupported language "${lang}".`,
            item.span,
            'Only "typescript" is supported for architecture declarations.',
            'Use (lang typescript).',
          );
        }
        break;
      }
      case "tsconfig": {
        ensureFieldUnset(tsconfig, "tsconfig", `Architecture "${id}" tsconfig`, CODE, item.span);
        tsconfig = readSingleString(item, `Architecture "${id}" tsconfig`, CODE);
        if (tsconfig.includes("..")) {
          throw validationError(
            CODE,
            `Architecture "${id}" tsconfig path must not contain "..".`,
            item.span,
            "Path traversal in tsconfig paths is not allowed.",
            'Use a path relative to the project root.',
          );
        }
        if (!tsconfig.endsWith(".json")) {
          throw validationError(
            CODE,
            `Architecture "${id}" tsconfig path must end in ".json".`,
            item.span,
            "The tsconfig value must be a path to a .json file.",
            'Use a path like "tsconfig.json".',
          );
        }
        break;
      }
      case "description": {
        ensureFieldUnset(description, "description", `Architecture "${id}" description`, CODE, item.span);
        description = readSingleString(item, `Architecture "${id}" description`, CODE);
        break;
      }
      case "deny-cycles": {
        ensureFieldUnset(hasSeenDenyCycles, "deny-cycles", `Architecture "${id}" deny-cycles`, CODE, item.span);
        hasSeenDenyCycles = true;
        // Handle bare (deny-cycles) form → true
        if (item.items.length === 0) {
          denyCycles = true;
          break;
        }
        const val = readSingleExpression(item, `Architecture "${id}" deny-cycles`, CODE);
        if (val.kind === "identifier") {
          if (val.value === "true") {
            denyCycles = true;
          } else if (val.value === "false") {
            denyCycles = false;
          } else {
            throw validationError(
              CODE,
              `Architecture "${id}" deny-cycles must be true or false.`,
              val.span,
              `Found "${val.value}".`,
              "Use true or false.",
            );
          }
        } else if (val.kind === "number") {
          denyCycles = val.value !== 0;
        } else {
          throw validationError(
            CODE,
            `Architecture "${id}" deny-cycles must be true or false.`,
            val.span,
            `Found ${val.kind}.`,
            "Use (deny-cycles) for true or (deny-cycles false) for false.",
          );
        }
        break;
      }
      case "fix": {
        ensureFieldUnset(fix, "fix", `Architecture "${id}" fix`, CODE, item.span);
        fix = readSingleString(item, `Architecture "${id}" fix`, CODE);
        break;
      }
      case "module": {
        const mod = parseModuleDeclaration(filePath, item);
        if (moduleIds.has(mod.id)) {
          throw validationError(
            CODE,
            `Architecture "${id}" has a duplicate module id "${mod.id}".`,
            mod.span,
            `Module "${mod.id}" was already declared.`,
            "Use unique module ids within an architecture.",
          );
        }
        moduleIds.add(mod.id);
        modules.push(mod);
        break;
      }
      case "layer": {
        const layer = parseLayerDeclaration(item);
        if (layerIds.has(layer.id)) {
          throw validationError(
            CODE,
            `Architecture "${id}" has a duplicate layer id "${layer.id}".`,
            layer.span,
            `Layer "${layer.id}" was already declared.`,
            "Use unique layer ids within an architecture.",
          );
        }
        layerIds.add(layer.id);
        layers.push(layer);
        break;
      }
      case "allow-dependency": {
        const dep = parseAllowDependencyDeclaration(item);
        allowDependencies.push(dep);
        break;
      }
      default:
        throw validationError(
          CODE,
          `Architecture "${id}" has an unknown field "${item.head}".`,
          item.span,
          "Supported architecture fields are: lang, tsconfig, description, deny-cycles, fix, module, layer, allow-dependency.",
          "Rename or remove this field.",
        );
    }
  }

  // Validate required fields
  if (lang === undefined) {
    throw validationError(
      CODE,
      `Architecture "${id}" must declare a (lang ...) field.`,
      node.span,
      "The language field is required.",
      'Add (lang typescript).',
    );
  }

  if (modules.length === 0) {
    throw validationError(
      CODE,
      `Architecture "${id}" must declare at least one (module ...) field.`,
      node.span,
      "At least one module is required.",
      'Add (module "name" (path "...") ...).',
    );
  }

  // Validate layer module references resolve to declared modules
  for (const layer of layers) {
    for (const modRef of layer.modules) {
      if (!moduleIds.has(modRef)) {
        throw validationError(
          CODE,
          `Architecture "${id}" layer "${layer.id}" references unknown module "${modRef}".`,
          layer.span,
          `Module "${modRef}" is not declared in this architecture.`,
          "Use a module id that exists in the same architecture declaration.",
        );
      }
    }
  }

  // Validate allow-dependency references resolve
  for (const dep of allowDependencies) {
    if (!moduleIds.has(dep.from)) {
      throw validationError(
        CODE,
        `Architecture "${id}" allow-dependency references unknown "from" module "${dep.from}".`,
        dep.span,
        `Module "${dep.from}" is not declared.`,
        "Use a module id that exists in the same architecture declaration.",
      );
    }
    for (const target of dep.to) {
      if (!moduleIds.has(target)) {
        throw validationError(
          CODE,
          `Architecture "${id}" allow-dependency references unknown target module "${target}".`,
          dep.span,
          `Module "${target}" is not declared.`,
          "Use a module id that exists in the same architecture declaration.",
        );
      }
    }
  }

  return {
    kind: "architecture",
    filePath,
    node,
    span: node.span,
    id,
    lang: lang as "typescript",
    tsconfig,
    description,
    modules,
    layers,
    allowDependencies,
    denyCycles,
    fix,
  };
}

function parseModuleDeclaration(filePath: string, node: ListNode): ArchitectureModuleDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE,
      "Module declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the module id.",
      'Use a form like (module "domain" (path "src/domain/**")).',
    );
  }

  const id = idNode.value;
  const paths: string[] = [];
  const publicEntries: string[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE,
        `Module "${id}" contains an unsupported field entry.`,
        item.span,
        "Module fields must be nested list forms such as (path ...) or (public-entry ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "path": {
        const pathValue = readSingleString(item, `Module "${id}" path`, CODE);
        paths.push(pathValue);
        break;
      }
      case "public-entry": {
        const entryValue = readSingleString(item, `Module "${id}" public-entry`, CODE);
        publicEntries.push(entryValue);
        break;
      }
      default:
        throw validationError(
          CODE,
          `Module "${id}" has an unknown field "${item.head}".`,
          item.span,
          "Supported module fields are: path, public-entry.",
          "Rename or remove this field.",
        );
    }
  }

  if (paths.length === 0) {
    throw validationError(
      CODE,
      `Module "${id}" must declare at least one (path ...) field.`,
      node.span,
      "Module declarations need at least one path pattern.",
      'Add (path "src/domain/**").',
    );
  }

  return {
    id,
    paths,
    publicEntries,
    span: node.span,
  };
}

function parseLayerDeclaration(node: ListNode): ArchitectureLayerDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE,
      "Layer declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the layer id.",
      'Use a form like (layer "presentation" "domain" "infrastructure").',
    );
  }

  const id = idNode.value;
  const modules: string[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind === "identifier" || item.kind === "string") {
      modules.push(item.value);
    } else if (item.kind === "list") {
      throw validationError(
        CODE,
        `Layer "${id}" contains an unsupported nested list.`,
        item.span,
        "Layer items should be module identifiers or string literals.",
        'Use plain identifiers like (layer "presentation" "domain").',
      );
    } else {
      throw validationError(
        CODE,
        `Layer "${id}" contains an unsupported value.`,
        item.span,
        "Layer items should be module identifiers or string literals.",
        "Use plain identifiers or quoted strings.",
      );
    }
  }

  if (modules.length === 0) {
    throw validationError(
      CODE,
      `Layer "${id}" must declare at least one module.`,
      node.span,
      "Layers need at least one module reference.",
      'Add module ids like (layer "infra" "database" "cache").',
    );
  }

  return {
    id,
    modules,
    span: node.span,
  };
}

function parseAllowDependencyDeclaration(node: ListNode): ArchitectureAllowDependencyDeclaration {
  const fromNode = node.items[0];

  if (fromNode?.kind !== "identifier" && fromNode?.kind !== "string") {
    throw validationError(
      CODE,
      "Allow-dependency declarations must start with a module id.",
      node.span,
      "The first item should be the 'from' module id.",
      'Use a form like (allow-dependency "domain" "infrastructure").',
    );
  }

  const from = fromNode.value;
  const to: string[] = [];

  for (const item of node.items.slice(1)) {
    if (item.kind === "identifier" || item.kind === "string") {
      to.push(item.value);
    } else if (item.kind === "list") {
      throw validationError(
        CODE,
        `Allow-dependency for "${from}" contains an unsupported nested list.`,
        item.span,
        "Allow-dependency items should be target module identifiers or string literals.",
        'Use plain identifiers like (allow-dependency "domain" "infrastructure").',
      );
    } else {
      throw validationError(
        CODE,
        `Allow-dependency for "${from}" contains an unsupported value.`,
        item.span,
        "Allow-dependency items should be target module identifiers or string literals.",
        "Use plain identifiers or quoted strings.",
      );
    }
  }

  if (to.length === 0) {
    throw validationError(
      CODE,
      `Allow-dependency for "${from}" must declare at least one target module.`,
      node.span,
      "Allow-dependency needs at least one target.",
      'Add target modules like (allow-dependency "domain" "infrastructure").',
    );
  }

  return {
    from,
    to,
    span: node.span,
  };
}
