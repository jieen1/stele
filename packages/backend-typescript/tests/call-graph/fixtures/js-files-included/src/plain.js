export function fromJs(value) {
  return value + 1;
}

export function jsCaller(x) {
  return fromJs(x);
}
