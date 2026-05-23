export class Thing {
  constructor(public id: number) {}
}

export function makeThings(): Thing[] {
  return [new Thing(1), new Thing(2)];
}
