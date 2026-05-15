import type { AstNode, ListNode } from "../ast/types.js";
import type {
  Contract,
  ContractFile,
  GroupDeclaration,
  InvariantDeclaration,
  InvariantMultiValueField,
  InvariantSingleValueField,
} from "../validator/structure.js";

const INDENT = "  ";

export function normalizeContract(contract: Contract): string {
  return contract.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => normalizeFile(file))
    .join("\n");
}

export function normalizeFile(file: ContractFile): string {
  const topLevelInvariants = new Map(file.invariants.filter((invariant) => invariant.groupId === undefined).map((invariant) => [invariant.node, invariant]));
  const groups = new Map(file.groups.map((group) => [group.node, group]));

  return file.parsed.body
    .map((node) => {
      if (node.kind !== "list") {
        return renderNode(node);
      }

      const group = groups.get(node);

      if (group !== undefined) {
        return renderGroup(group);
      }

      const invariant = topLevelInvariants.get(node);

      if (invariant !== undefined) {
        return renderInvariant(invariant);
      }

      return renderNode(node);
    })
    .join("\n");
}

function renderGroup(group: GroupDeclaration, indent = 0): string {
  const items: string[] = [];

  if (group.description !== undefined) {
    items.push(renderList("description", [renderString(group.description)], indent + 1));
  }

  items.push(...group.invariants.map((invariant) => renderInvariant(invariant, indent + 1)));

  return wrapBlock(`(group ${group.id}`, items, indent);
}

function renderInvariant(invariant: InvariantDeclaration, indent = 0): string {
  const items = [
    renderList("severity", [renderSeverityValue(invariant)], indent + 1),
    renderList("description", [renderString(invariant.description)], indent + 1),
    invariant.assertExpression === undefined
      ? renderList(
          "uses-checker",
          [invariant.usesChecker!.checkerId, ...invariant.usesChecker!.args.map((arg) => renderNode(arg))],
          indent + 1,
        )
      : renderList("assert", [renderNode(invariant.assertExpression)], indent + 1),
    renderOptionalInvariantField("when", invariant.whenExpression, indent + 1),
    renderDependsOn(invariant.dependsOn.map((dependency) => dependency.id), indent + 1),
    renderSingleValueField(invariant.category, indent + 1),
    renderMultiValueField(invariant.tags, indent + 1),
    renderSingleValueField(invariant.tolerance, indent + 1),
    renderSingleValueField(invariant.rationale, indent + 1),
    renderSingleValueField(invariant.since, indent + 1),
    renderSingleValueField(invariant.appliesTo, indent + 1),
    renderSingleValueField(invariant.explain, indent + 1),
    renderSingleValueField(invariant.explain, indent + 1),
  ].filter((item): item is string => item !== undefined);

  return wrapBlock(`(invariant ${invariant.id}`, items, indent);
}

function renderSeverityValue(invariant: InvariantDeclaration): string {
  const severityField = invariant.node.items.find(
    (item): item is ListNode => item.kind === "list" && item.head === "severity",
  );

  if (severityField?.items[0] !== undefined) {
    return renderNode(severityField.items[0]);
  }

  return renderText(invariant.severity);
}

function renderOptionalInvariantField(name: string, value: AstNode | undefined, indent: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return renderList(name, [renderNode(value)], indent);
}

function renderDependsOn(ids: string[], indent: number): string | undefined {
  if (ids.length === 0) {
    return undefined;
  }

  return renderList("depends-on", ids, indent);
}

function renderSingleValueField(field: InvariantSingleValueField | undefined, indent: number): string | undefined {
  if (field === undefined) {
    return undefined;
  }

  return renderList(field.name, [renderNode(field.valueNode)], indent);
}

function renderMultiValueField(field: InvariantMultiValueField | undefined, indent: number): string | undefined {
  if (field === undefined) {
    return undefined;
  }

  return renderList(field.name, field.valueNodes.map((node) => renderNode(node)), indent);
}

function renderNode(node: AstNode): string {
  switch (node.kind) {
    case "identifier":
      return node.value;
    case "keyword":
      return node.value.startsWith(":") ? node.value : `:${node.value}`;
    case "string":
      return renderString(node.value);
    case "number":
      return node.raw;
    case "list":
      return renderList(node.head, node.items.map((item) => renderNode(item)));
  }
}

function renderList(head: string, items: string[], indent = 0): string {
  const prefix = INDENT.repeat(indent);

  if (items.length === 0) {
    return `${prefix}(${head})`;
  }

  if (items.every((item) => !item.includes("\n"))) {
    return `${prefix}(${head} ${items.join(" ")})`;
  }

  return `${prefix}(${head}\n${items.map((item) => indentBlock(item, indent + 1)).join("\n")})`;
}

function wrapBlock(header: string, items: string[], indent: number): string {
  if (items.length === 0) {
    return `${INDENT.repeat(indent)}${header})`;
  }

  return `${INDENT.repeat(indent)}${header}\n${items.join("\n")})`;
}

function indentBlock(value: string, indent: number): string {
  const prefix = INDENT.repeat(indent);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderString(value: string): string {
  return JSON.stringify(value);
}

function renderText(value: string): string {
  return JSON.stringify(value) === `"${value}"` && !value.includes(" ") ? value : renderString(value);
}
