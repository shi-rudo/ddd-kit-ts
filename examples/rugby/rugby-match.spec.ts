import { describe, expect, it } from "vitest";
import { type MatchId, RugbyMatch, type Team } from "./rugby-match";

describe("RugbyMatch Aggregate", () => {
	const homeTeam: Team = { id: "team-1", name: "All Blacks" };
	const awayTeam: Team = { id: "team-2", name: "Springboks" };
	const matchId = "match-1" as MatchId;

	it("should be scheduled", () => {
		const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
		expect(match.state.status).toBe("scheduled");
		expect(match.pendingEvents).toHaveLength(1);
		expect(match.pendingEvents[0].type).toBe("MatchScheduled");
	});

	it("should score a try and update the score", () => {
		const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
		match.scoreTry(homeTeam.id, "Richie McCaw");
		expect(match.state.homeScore).toBe(5);
		expect(match.state.scoringPlays[0].playerName).toBe("Richie McCaw");
		expect(match.state.status).toBe("in-progress");
	});

	it("should score a conversion", () => {
		const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
		match.scoreTry(homeTeam.id, "Richie McCaw");
		match.scoreConversion(homeTeam.id, "Dan Carter");
		expect(match.state.homeScore).toBe(7);
		expect(match.state.scoringPlays[1].playerName).toBe("Dan Carter");
	});

	it("should score a penalty goal", () => {
		const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
		match.scorePenaltyGoal(awayTeam.id, "Frans Steyn");
		expect(match.state.awayScore).toBe(3);
		expect(match.state.scoringPlays[0].playerName).toBe("Frans Steyn");
	});

	it("should be able to finish", () => {
		const match = RugbyMatch.schedule(matchId, homeTeam, awayTeam, new Date());
		match.finish();
		expect(match.state.status).toBe("finished");
	});
});
