export class Widget {
  constructor(public id: string) {}
}

export function make(): Widget {
  return new Widget("w1");
}
