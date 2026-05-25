export class Base {
  constructor(public label: string) {}
}

export class Mid extends Base {
  constructor(label: string, public extra: number) {
    super(label);
  }
}

export class Leaf extends Mid {
  constructor(label: string) {
    super(label, 42);
  }
}
