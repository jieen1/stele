export interface Animal {
  speak(): string;
}

export class Dog implements Animal {
  speak(): string {
    return "woof";
  }
}

export class Cat implements Animal {
  speak(): string {
    return "meow";
  }
}

export function greet(a: Animal): string {
  return a.speak();
}
