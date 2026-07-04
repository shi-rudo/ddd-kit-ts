// Utility entry point (`@shirudo/ddd-kit/utils`): the deep-equality
// toolkit the Value Object helpers are built on. Named exports only; the
// sibling modules under utils/ (abort, is-built-in) are internal.
export { deepEqual } from "./utils/array/deep-equal";
export {
	type DeepEqualExceptOptions,
	deepEqualExcept,
} from "./utils/array/deep-equal-except";
export {
	type DeepOmitOptions,
	deepOmit,
	type Key,
	type PathSegment,
} from "./utils/array/deep-omit";
