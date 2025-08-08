import { err, ok, type Result } from "./result";

export function ensure(cond: boolean, error: string): Result<true, string> {
	return cond ? ok(true) : err(error);
}
