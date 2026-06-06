import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Un-annotated network effect via global fetch.
export async function doFetch(url: string): Promise<void> {
  await fetch(url);
}

// fs.write via named import.
export function doWrite(): void {
  writeFileSync("a.txt", "b");
}

// fs.read via named import.
export function doRead(): string {
  return readFileSync("a.txt", "utf-8");
}

// child-process via named import.
export function doExec(): void {
  execSync("ls");
}

// random via Math.random.
export function doRandom(): number {
  return Math.random();
}

// time via Date.now.
export function doTime(): number {
  return Date.now();
}

// env via process.env access.
export function doEnv(): string | undefined {
  return process.env.FOO;
}

// process via process.cwd().
export function doProcess(): string {
  return process.cwd();
}

// NO FALSE POSITIVE: a user class whose own method is named writeFileSync.
export class FakeFs {
  writeFileSync(): void {
    // user-defined, not node:fs
  }

  use(): void {
    this.writeFileSync();
  }
}

// NO FALSE POSITIVE: RegExp.prototype.exec is NOT child_process.exec.
export function regexExec(pattern: string): boolean {
  const m = /\(([^()]*)\)/.exec(pattern);
  return m !== null;
}

// NO FALSE POSITIVE: a user-defined `read` method on an array-ish object
// is not node:fs read.
export function arrayLikeRead(buf: { read(): number }): number {
  return buf.read();
}

// A function with NO effects at all.
export function pure(a: number, b: number): number {
  return a + b;
}
