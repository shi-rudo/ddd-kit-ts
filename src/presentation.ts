// Transport-neutral presentation helpers. Opt-in entry point
// (`@shirudo/ddd-kit/presentation`) so the core kit stays free of
// presentation strings. These project the kit's technical errors into
// client-safe public views; the transport mapping (HTTP status, gRPC, CLI
// exit code) stays the consumer's concern.
export {
	type PublicErrorViewDetails,
	type PublicErrorViewOptions,
	toPublicErrorView,
} from "./presentation/public-error-view";
