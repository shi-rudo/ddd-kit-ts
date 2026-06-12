// HTTP / transport presenters. Opt-in entry point (`@shirudo/ddd-kit/http`) so
// the core kit stays free of transport concerns. Import only when you map
// domain results to HTTP responses.
export {
	toProblemDetails,
	type ValidationProblemMember,
	type ValidationProblemOptions,
} from "./http/problem-details";
