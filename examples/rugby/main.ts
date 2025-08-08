// To run this example, execute the following command in your terminal:
// npx tsx examples/rugby/main.ts

import { type MatchId, RugbyMatch, type Team } from "./rugby-match";

function main() {
	console.log("--- Scheduling a new rugby match ---");
	const matchId = "match-ger-vs-bel" as MatchId;
	const homeTeam: Team = { id: "team-ger", name: "Germany" };
	const awayTeam: Team = { id: "team-bel", name: "Belgium" };
	const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());

	console.log("Initial state:", match.state);
	console.log(
		"Pending events:",
		match.pendingEvents.map((e) => e.type),
	);
	match.clearPendingEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a try for Germany ---");
	match.scoreTry(homeTeam.id, "Hans Tebroke");
	console.log("Current state:", match.state);
	console.log("Scoring plays:", match.state.scoringPlays);
	console.log(
		"Pending events:",
		match.pendingEvents.map((e) => e.type),
	);
	match.clearPendingEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a conversion for Germany ---");
	match.scoreConversion(homeTeam.id, "Hans Tebroke");
	console.log("Current state:", match.state);
	console.log("Scoring plays:", match.state.scoringPlays);
	console.log(
		"Pending events:",
		match.pendingEvents.map((e) => e.type),
	);
	match.clearPendingEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a penalty for Belgium ---");
	match.scorePenaltyGoal(awayTeam.id, "Alan Williams");
	console.log("Current state:", match.state);
	console.log("Scoring plays:", match.state.scoringPlays);
	console.log(
		"Pending events:",
		match.pendingEvents.map((e) => e.type),
	);
	match.clearPendingEvents();
	console.log("---------------------------------");

	console.log("\n--- Finishing the match ---");
	match.finish();
	console.log("Final state:", match.state);
	console.log(
		"Pending events:",
		match.pendingEvents.map((e) => e.type),
	);
	match.clearPendingEvents();
	console.log("---------------------------------");
}

main();
