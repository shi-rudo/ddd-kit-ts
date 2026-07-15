// To run this example, execute the following command in your terminal:
// npx tsx examples/rugby/main.ts

import { type MatchId, RugbyMatch, type Team } from "./rugby-match";

function main() {
	console.log("--- Scheduling a new rugby match ---");
	const matchId = "match-ger-vs-bel" as MatchId;
	const homeTeam: Team = { id: "team-ger", name: "Germany" };
	const awayTeam: Team = { id: "team-bel", name: "Belgium" };
	const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
	let displayedEventCount = 0;
	const logNewEvents = (): void => {
		console.log(
			"New pending events:",
			match.pendingEvents.slice(displayedEventCount).map((event) => event.type),
		);
		displayedEventCount = match.pendingEvents.length;
	};

	console.log("Initial state:", match.view);
	logNewEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a try for Germany ---");
	match.scoreTry(homeTeam.id, "Hans Tebroke");
	console.log("Current state:", match.view);
	console.log("Scoring plays:", match.view.scoringPlays);
	logNewEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a conversion for Germany ---");
	match.scoreConversion(homeTeam.id, "Hans Tebroke");
	console.log("Current state:", match.view);
	console.log("Scoring plays:", match.view.scoringPlays);
	logNewEvents();
	console.log("---------------------------------");

	console.log("\n--- Scoring a penalty for Belgium ---");
	match.scorePenaltyGoal(awayTeam.id, "Alan Williams");
	console.log("Current state:", match.view);
	console.log("Scoring plays:", match.view.scoringPlays);
	logNewEvents();
	console.log("---------------------------------");

	console.log("\n--- Finishing the match ---");
	match.finish();
	console.log("Final state:", match.view);
	logNewEvents();
	console.log("---------------------------------");
}

main();
