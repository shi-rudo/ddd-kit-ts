import { EventSourcedAggregate } from "../../src/domain/aggregate/event-sourced-aggregate";
import type { UncommittedDomainEventOf } from "../../src/domain/event/domain-event";
import type { Id } from "../../src/domain/identity/id";
import { deepFreeze } from "../../src/domain/value-object/value-object";
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
export type MatchView = Readonly<{
	homeTeam: Readonly<Team>;
	awayTeam: Readonly<Team>;
	homeScore: number;
	awayScore: number;
	status: MatchStatus;
	date: Date;
	scoringPlays: ReadonlyArray<Readonly<ScoringPlay>>;
}>;

export class RugbyMatch extends EventSourcedAggregate<
	MatchState,
	RugbyMatchEvent,
	MatchId
> {
	protected readonly aggregateType = "RugbyMatch";

	get view(): MatchView {
		return deepFreeze(structuredClone(this.state)) as MatchView;
	}

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
		match.apply(
			match.createEvent<MatchScheduled>("MatchScheduled", {
				homeTeam,
				awayTeam,
				date,
			}),
		);
		return match;
	}

	scoreTry(teamId: string, playerName: string): void {
		this.apply(
			this.createEvent<TryScored>("TryScored", {
				teamId,
				playerName,
				points: 5,
			}),
		);
	}

	scoreConversion(teamId: string, playerName: string): void {
		this.apply(
			this.createEvent<ConversionScored>("ConversionScored", {
				teamId,
				playerName,
				points: 2,
			}),
		);
	}

	scorePenaltyGoal(teamId: string, playerName: string): void {
		this.apply(
			this.createEvent<PenaltyGoalScored>("PenaltyGoalScored", {
				teamId,
				playerName,
				points: 3,
			}),
		);
	}

	finish(): void {
		this.apply(this.createEvent<MatchFinished>("MatchFinished", {}));
	}

	protected readonly handlers = {
		MatchScheduled: (
			state: MatchState,
			event: UncommittedDomainEventOf<MatchScheduled>,
		): MatchState => ({
			...state,
			homeTeam: event.payload.homeTeam,
			awayTeam: event.payload.awayTeam,
			date: event.payload.date,
			status: "scheduled",
		}),
		TryScored: (
			state: MatchState,
			event: UncommittedDomainEventOf<TryScored>,
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
			status: "in-progress",
			scoringPlays: [...state.scoringPlays, { type: "Try", ...event.payload }],
		}),
		ConversionScored: (
			state: MatchState,
			event: UncommittedDomainEventOf<ConversionScored>,
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
			event: UncommittedDomainEventOf<PenaltyGoalScored>,
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
