/**
 * The deepest nesting that a walk of the kit enters: 100 levels of objects,
 * arrays, maps, and sets. It equals the data depth that the log of
 * `@shirudo/base-error` keeps. A recursive walk overflows the stack of
 * Node.js and workerd after about 1,100 levels, and the stack that a caller
 * already uses lowers that number, so only a fixed limit fails the same way
 * on every runtime.
 */
export const MAX_NESTING_DEPTH = 100;
