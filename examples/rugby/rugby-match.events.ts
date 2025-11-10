import type { DomainEvent } from "../../src/aggregate/aggregate";
import type { Team } from "./rugby-match";

export type MatchScheduled = DomainEvent<
	"MatchScheduled",
	{
		homeTeam: Team;
		awayTeam: Team;
		date: Date;
	}
>;

export type TryScored = DomainEvent<
	"TryScored",
	{
		teamId: string;
		playerName: string;
		points: 5;
	}
>;

export type ConversionScored = DomainEvent<
	"ConversionScored",
	{
		teamId: string;
		playerName: string;
		points: 2;
	}
>;

export type PenaltyGoalScored = DomainEvent<
	"PenaltyGoalScored",
	{
		teamId: string;
		playerName: string;
		points: 3;
	}
>;

export type MatchFinished = DomainEvent<"MatchFinished", Record<string, never>>;

export type RugbyMatchEvent =
	| MatchScheduled
	| TryScored
	| ConversionScored
	| PenaltyGoalScored
	| MatchFinished;
