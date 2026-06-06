export function sink(): void {
  // the forbidden target
}

// Single-hop alias of an in-project function: `const w = sink; w()`.
// Without alias deref this call is unresolved (a non-function variable),
// hiding the edge `aliased -> sink` from the trace/effect analysis.
export function aliased(): void {
  const w = sink;
  w();
}

// Direct call for comparison — always an edge.
export function direct(): void {
  sink();
}
