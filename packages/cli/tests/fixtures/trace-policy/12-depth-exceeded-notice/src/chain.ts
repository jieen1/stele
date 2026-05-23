import { database } from "./database.js";

// A 15-hop chain F0 -> F1 -> ... -> F14 -> Database.query.
// Default maxDepth=10 — the enumerator hits the cap before reaching the
// target, so the evaluator emits a `path_exceeded_max_depth` notice
// instead of a real violation.
export class F0  { run(id: string): unknown { return new F1().run(id); } }
export class F1  { run(id: string): unknown { return new F2().run(id); } }
export class F2  { run(id: string): unknown { return new F3().run(id); } }
export class F3  { run(id: string): unknown { return new F4().run(id); } }
export class F4  { run(id: string): unknown { return new F5().run(id); } }
export class F5  { run(id: string): unknown { return new F6().run(id); } }
export class F6  { run(id: string): unknown { return new F7().run(id); } }
export class F7  { run(id: string): unknown { return new F8().run(id); } }
export class F8  { run(id: string): unknown { return new F9().run(id); } }
export class F9  { run(id: string): unknown { return new F10().run(id); } }
export class F10 { run(id: string): unknown { return new F11().run(id); } }
export class F11 { run(id: string): unknown { return new F12().run(id); } }
export class F12 { run(id: string): unknown { return new F13().run(id); } }
export class F13 { run(id: string): unknown { return new F14().run(id); } }
export class F14 { run(id: string): unknown { return database.query(`SELECT '${id}'`); } }
