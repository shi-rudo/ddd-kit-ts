import type { Id } from "../../src/core/id";
import { AggregateBase } from "../../src/entity/aggregate-base";
import type {
	ConversionScored,
	MatchFinished,
	MatchScheduled,
	PenaltyGoalScored,
	RugbyMatchEvent,
	TryScored,
} from "./rugby-match.events";

export type MatchId = Id<"MatchId">;
export type Team = {
	id: string;
	name: string;
};

export type ScoringPlay = {
	type: "Try" | "Conversion" | "PenaltyGoal";
	points: number;
	teamId: string;
	playerName: string;
};

export type MatchStatus = "scheduled" | "in-progress" | "finished";
export type MatchState = {
	homeTeam: Team;
	awayTeam: Team;
	homeScore: number;
	awayScore: number;
	status: MatchStatus;
	date: Date;
	scoringPlays: ScoringPlay[];
};

export class RugbyMatch extends AggregateBase<
	MatchState,
	RugbyMatchEvent,
	MatchId
> {
	static schedule(
		id: MatchId,
		homeTeam: Team,
		awayTeam: Team,
		date: Date,
	): RugbyMatch {
		const initialState: MatchState = {
			homeTeam,
			awayTeam,
			homeScore: 0,
			awayScore: 0,
			status: "scheduled",
			date,
			scoringPlays: [],
		};
		const match = new RugbyMatch(id, initialState);
		match.apply({
			type: "MatchScheduled",
			payload: { homeTeam, awayTeam, date },
		} as MatchScheduled);
		return match;
	}

	scoreTry(teamId: string, playerName: string): void {
		this.apply({
			type: "TryScored",
			payload: { teamId, playerName, points: 5 },
		} as TryScored);
	}

	scoreConversion(teamId: string, playerName: string): void {
		this.apply({
			type: "ConversionScored",
			payload: { teamId, playerName, points: 2 },
		} as ConversionScored);
	}

	scorePenaltyGoal(teamId: string, playerName: string): void {
		this.apply({
			type: "PenaltyGoalScored",
			payload: { teamId, playerName, points: 3 },
		} as PenaltyGoalScored);
	}

	finish(): void {
		this.apply({ type: "MatchFinished" } as MatchFinished);
	}

	protected readonly handlers = {
		MatchScheduled: (state: MatchState, event: MatchScheduled): MatchState => ({
			...state,
			homeTeam: event.payload.homeTeam,
			awayTeam: event.payload.awayTeam,
			date: event.payload.date,
			status: "scheduled",
		}),
		TryScored: (state: MatchState, event: TryScored): MatchState => ({
			...state,
			homeScore:
				state.homeTeam.id === event.payload.teamId
					? state.homeScore + event.payload.points
					: state.homeScore,
			awayScore:
				state.awayTeam.id === event.payload.teamId
					? state.awayScore + event.payload.points
					: state.awayScore,
			status: "in-progress",
			scoringPlays: [...state.scoringPlays, { type: "Try", ...event.payload }],
		}),
		ConversionScored: (
			state: MatchState,
			event: ConversionScored,
		): MatchState => ({
			...state,
			homeScore:
				state.homeTeam.id === event.payload.teamId
					? state.homeScore + event.payload.points
					: state.homeScore,
			awayScore:
				state.awayTeam.id === event.payload.teamId
					? state.awayScore + event.payload.points
					: state.awayScore,
			scoringPlays: [
				...state.scoringPlays,
				{ type: "Conversion", ...event.payload },
			],
		}),
		PenaltyGoalScored: (
			state: MatchState,
			event: PenaltyGoalScored,
		): MatchState => ({
			...state,
			homeScore:
				state.homeTeam.id === event.payload.teamId
					? state.homeScore + event.payload.points
					: state.homeScore,
			awayScore:
				state.awayTeam.id === event.payload.teamId
					? state.awayScore + event.payload.points
					: state.awayScore,
			scoringPlays: [
				...state.scoringPlays,
				{ type: "PenaltyGoal", ...event.payload },
			],
		}),
		MatchFinished: (state: MatchState): MatchState => ({
			...state,
			status: "finished",
		}),
	};
}
