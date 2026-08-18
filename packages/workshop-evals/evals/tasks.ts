import { randomUUID } from "node:crypto";
import type { JsonValue } from "@vitest-evals/core";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import { z } from "zod";
import type {
  WorkshopCheckResult, WorkshopEvalTask, WorkshopVerificationContext,
} from "../src/task.js";

const DEFAULT_MODELS = ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"] as const;

const MutationSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).strict(),
]);
type Mutation = z.infer<typeof MutationSchema>;
const CompletionMutationSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), added: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

type CheckOutcome = { pass: boolean; evidence?: JsonValue };

async function check(
    id: string, operation: () => Promise<CheckOutcome>): Promise<WorkshopCheckResult> {
  try {
    return { id, ...await operation() };
  } catch (error) {
    return {
      id,
      pass: false,
      evidence: error instanceof Error ? error.message : "RPC verification failed",
    };
  }
}

function gadgetId(context: WorkshopVerificationContext, title: string): WorkpieceId {
  const matches = context.workpieces.filter(workpiece =>
    workpiece.type === "gadget" && workpiece.title === title);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Gadget named ${JSON.stringify(title)}, found ${matches.length}`);
  }
  const match = matches.at(0);
  if (match === undefined) throw new Error(`Gadget ${JSON.stringify(title)} was not found`);
  return match.id;
}

function accepted(result: Mutation): boolean {
  return result.ok;
}

function rejected(result: Mutation, error: string): boolean {
  return !result.ok && result.error === error;
}

function sameValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type HabitDashboard = z.infer<typeof HabitDashboardSchema>;
const HabitDashboardSchema = z.object({
  habits: z.array(z.object({
    id: z.string(),
    name: z.string(),
    weeklyTarget: z.number().int().positive(),
    completionCount: z.number().int().nonnegative(),
    progress: z.number().min(0).max(1),
    dates: z.array(z.string()),
  }).strict()),
}).strict();
interface HabitApi {
  addHabit(input: { id: string; name: string; weeklyTarget: number }): Promise<Mutation>;
  recordCompletion(input: { habitId: string; date: string }): Promise<
    { ok: true; added: boolean } | { ok: false; error: string }
  >;
  getDashboard(input: { weekStart: string }): Promise<HabitDashboard>;
}

const habitTask: WorkshopEvalTask = {
  id: "momentum-habit-tracker",
  title: "Momentum habit tracker",
  expectation: "required",
  turns: [{
    prompt: `Build a habit tracker Gadget named exactly "Momentum". Make it quick to read and use on
desktop and mobile, with weekly progress and clear completion feedback. I also need a stable
plain-data server RPC for verification. Expose exactly these methods and contracts:
- addHabit({ id: string, name: string, weeklyTarget: positive integer }) ->
  { ok: true } | { ok: false, error: string }
- recordCompletion({ habitId: string, date: "YYYY-MM-DD" }) ->
  { ok: true, added: boolean } | { ok: false, error: string }. Repeating the same habit/date is
  idempotent and returns added: false.
- getDashboard({ weekStart: "YYYY-MM-DD" }) -> { habits: Array<{ id: string, name: string,
  weeklyTarget: number, completionCount: number, progress: number from 0 to 1, dates: string[] }> }.
  Include only completions in the seven-day week beginning weekStart.
Unknown habit IDs must return { ok: false, error: "UNKNOWN_HABIT" } without changing state. Keep all
RPC arguments and results plain serializable data.`,
    verify: async context => [await check("habit.behavior", async () => {
      using api = await context.connect<HabitApi>(gadgetId(context, "Momentum"));
      const added = [
        MutationSchema.parse(await api.addHabit({ id: "move", name: "Move", weeklyTarget: 5 })),
        MutationSchema.parse(await api.addHabit({ id: "read", name: "Read", weeklyTarget: 4 })),
      ];
      const completions = [];
      for (const date of ["2026-08-17", "2026-08-18", "2026-08-19"]) {
        completions.push(CompletionMutationSchema.parse(
            await api.recordCompletion({ habitId: "move", date })));
      }
      const duplicate = CompletionMutationSchema.parse(
          await api.recordCompletion({ habitId: "move", date: "2026-08-18" }));
      for (const date of ["2026-08-17", "2026-08-20"]) {
        completions.push(CompletionMutationSchema.parse(
            await api.recordCompletion({ habitId: "read", date })));
      }
      const before = HabitDashboardSchema.parse(await api.getDashboard({ weekStart: "2026-08-17" }));
      const missing = CompletionMutationSchema.parse(
          await api.recordCompletion({ habitId: "missing", date: "2026-08-21" }));
      const after = HabitDashboardSchema.parse(await api.getDashboard({ weekStart: "2026-08-17" }));
      const move = after.habits.find(habit => habit.id === "move");
      const read = after.habits.find(habit => habit.id === "read");
      const pass = added.every(accepted) && completions.every(result => result.ok && result.added) &&
        duplicate.ok && !duplicate.added && !missing.ok && missing.error === "UNKNOWN_HABIT" &&
        sameValue(before, after) && move?.completionCount === 3 && move.progress === 0.6 &&
        read?.completionCount === 2 && read.progress === 0.5;
      return { pass, evidence: { duplicate, missing, dashboard: after } };
    })],
  }],
  rubric: [
    { id: "habit-hierarchy", criterion: "Weekly progress and the next useful action are easy to find.", weight: 2 },
    { id: "habit-completion", criterion: "Completed days and current weekly progress are clearly visible.", weight: 1 },
    { id: "habit-accessibility", criterion: "Progress is understandable without relying only on color.", weight: 1 },
    { id: "habit-mobile", criterion: "Habit rows and controls remain readable and usable at the mobile viewport.", weight: 1 },
  ],
};

const ExpenseSummarySchema = z.object({
  totalExpenseCents: z.number().int(),
  expenseCount: z.number().int().nonnegative(),
  balances: z.array(z.object({ name: z.string(), balanceCents: z.number().int() }).strict()),
}).strict();
type ExpenseSummary = z.infer<typeof ExpenseSummarySchema>;
interface ExpenseApi {
  setParticipants(input: { names: string[] }): Promise<Mutation>;
  addExpense(input: {
    id: string; paidBy: string; amountCents: number; splitAmong: string[];
  }): Promise<Mutation>;
  getSummary(): Promise<ExpenseSummary>;
}

const expenseTask: WorkshopEvalTask = {
  id: "expense-splitter",
  title: "Expense splitter",
  expectation: "required",
  turns: [{
    prompt: `Create a Gadget named exactly "Split Fair" for splitting group expenses in whole cents.
Show who is owed money and who owes money, with clear entry feedback and a useful mobile layout.
Expose this stable plain-data server RPC:
- setParticipants({ names: string[] }) -> { ok: true } | { ok: false, error: string }
- addExpense({ id: string, paidBy: string, amountCents: positive integer, splitAmong: string[] }) ->
  { ok: true } | { ok: false, error: string }. Divide cents deterministically in splitAmong order.
- getSummary() -> { totalExpenseCents: number, expenseCount: number,
  balances: Array<{ name: string, balanceCents: integer }> }. Positive means the person is owed money,
  negative means they owe money, and balances must sum to zero.
An unknown participant in paidBy or splitAmong must return { ok: false, error: "UNKNOWN_PARTICIPANT" }
without changing state. RPC inputs and results must contain only plain serializable data.`,
    verify: async context => [await check("expense.behavior", async () => {
      using api = await context.connect<ExpenseApi>(gadgetId(context, "Split Fair"));
      const setup = MutationSchema.parse(await api.setParticipants({ names: ["Ava", "Ben", "Chen"] }));
      const first = MutationSchema.parse(await api.addExpense({
        id: "dinner", paidBy: "Ava", amountCents: 1200, splitAmong: ["Ava", "Ben", "Chen"],
      }));
      const second = MutationSchema.parse(await api.addExpense({
        id: "taxi", paidBy: "Ben", amountCents: 500, splitAmong: ["Ben", "Chen"],
      }));
      const before = ExpenseSummarySchema.parse(await api.getSummary());
      const invalid = MutationSchema.parse(await api.addExpense({
        id: "invalid", paidBy: "Nobody", amountCents: 100, splitAmong: ["Ava", "Nobody"],
      }));
      const after = ExpenseSummarySchema.parse(await api.getSummary());
      const balances = Object.fromEntries(after.balances.map(entry => [entry.name, entry.balanceCents]));
      const sum = after.balances.reduce((total, entry) => total + entry.balanceCents, 0);
      return {
        pass: accepted(setup) && accepted(first) && accepted(second) &&
          rejected(invalid, "UNKNOWN_PARTICIPANT") && sameValue(before, after) &&
          balances.Ava === 800 && balances.Ben === -150 && balances.Chen === -650 && sum === 0 &&
          after.totalExpenseCents === 1700 && after.expenseCount === 2,
        evidence: { invalid, summary: after, balanceSum: sum },
      };
    })],
  }],
  rubric: [
    { id: "expense-clarity", criterion: "Amounts owed and owing are immediately distinguishable with labels or signs.", weight: 2 },
    { id: "expense-entry", criterion: "The expense form communicates each required value and its units clearly.", weight: 1 },
    { id: "expense-mobile", criterion: "Balances and expense entry remain usable without horizontal crowding on mobile.", weight: 1 },
  ],
};

const InventorySchema = z.object({
  items: z.array(z.object({
    id: z.string(), name: z.string(), stock: z.number().int().nonnegative(),
    reorderThreshold: z.number().int().nonnegative(), needsReorder: z.boolean(),
  }).strict()),
}).strict();
type Inventory = z.infer<typeof InventorySchema>;
interface InventoryApi {
  upsertItem(input: {
    id: string; name: string; stock: number; reorderThreshold: number;
  }): Promise<Mutation>;
  adjustStock(input: { id: string; delta: number }): Promise<Mutation>;
  listInventory(): Promise<Inventory>;
}

const inventoryTask: WorkshopEvalTask = {
  id: "inventory-reorder-dashboard",
  title: "Inventory/reorder dashboard",
  expectation: "required",
  turns: [{
    prompt: `Build an inventory and reorder dashboard Gadget named exactly "Stock Watch". Make low-stock
items obvious with text or icons as well as color, and make stock adjustments practical on desktop
and mobile. Expose a stable plain-data server RPC with these exact contracts:
- upsertItem({ id: string, name: string, stock: non-negative integer, reorderThreshold: non-negative
  integer }) -> { ok: true } | { ok: false, error: string }
- adjustStock({ id: string, delta: integer }) -> { ok: true } | { ok: false, error: string }
- listInventory() -> { items: Array<{ id: string, name: string, stock: number,
  reorderThreshold: number, needsReorder: boolean }> }. needsReorder is stock <= reorderThreshold.
An adjustment that would make stock negative must return { ok: false, error: "NEGATIVE_STOCK" }
and leave the item unchanged. Keep RPC data plain and serializable.`,
    verify: async context => [await check("inventory.behavior", async () => {
      using api = await context.connect<InventoryApi>(gadgetId(context, "Stock Watch"));
      const seed = MutationSchema.parse(await api.upsertItem({
        id: "filters", name: "Water filters", stock: 2, reorderThreshold: 3,
      }));
      const low = InventorySchema.parse(await api.listInventory());
      const replenish = MutationSchema.parse(await api.adjustStock({ id: "filters", delta: 4 }));
      const replenished = InventorySchema.parse(await api.listInventory());
      const invalid = MutationSchema.parse(await api.adjustStock({ id: "filters", delta: -7 }));
      const after = InventorySchema.parse(await api.listInventory());
      const restoreLow = MutationSchema.parse(await api.adjustStock({ id: "filters", delta: -3 }));
      const final = InventorySchema.parse(await api.listInventory());
      return {
        pass: accepted(seed) && low.items.at(0)?.needsReorder === true && accepted(replenish) &&
          replenished.items.at(0)?.stock === 6 && replenished.items.at(0)?.needsReorder === false &&
          rejected(invalid, "NEGATIVE_STOCK") && sameValue(replenished, after) &&
          accepted(restoreLow) && final.items.at(0)?.stock === 3 &&
          final.items.at(0)?.needsReorder === true,
        evidence: { low, invalid, after, final },
      };
    })],
  }],
  rubric: [
    { id: "inventory-hierarchy", criterion: "Low-stock items and current quantities dominate the information hierarchy.", weight: 2 },
    { id: "inventory-controls", criterion: "Stock adjustment controls communicate their action and quantity clearly.", weight: 1 },
    { id: "inventory-accessibility", criterion: "Reorder status uses a non-color cue such as text, icon, or shape.", weight: 1 },
    { id: "inventory-mobile", criterion: "Inventory scanning and adjustment controls remain usable on mobile.", weight: 1 },
  ],
};

const GameSchema = z.object({
  board: z.array(z.enum(["X", "O"]).nullable()).length(9),
  currentPlayer: z.enum(["X", "O"]),
  status: z.enum(["playing", "won", "draw"]),
  winner: z.enum(["X", "O"]).nullable(),
}).strict();
type Game = z.infer<typeof GameSchema>;
interface TicTacToeApi {
  play(input: { index: number }): Promise<Mutation>;
  reset(): Promise<Mutation>;
  getGame(): Promise<Game>;
}

const ticTacToeTask: WorkshopEvalTask = {
  id: "tic-tac-toe",
  title: "Tic-tac-toe",
  expectation: "required",
  turns: [{
    prompt: `Make a polished two-player tic-tac-toe Gadget named exactly "Three in a Row". The board
must be comfortable to tap on mobile, show whose turn it is, announce wins clearly, and not rely on
color alone. Expose this stable plain-data server RPC:
- play({ index: integer from 0 through 8 }) -> { ok: true } | { ok: false, error: string }
- reset() -> { ok: true } | { ok: false, error: string }
- getGame() -> { board: Array<"X" | "O" | null> with length 9, currentPlayer: "X" | "O",
  status: "playing" | "won" | "draw", winner: "X" | "O" | null }
Playing an occupied cell returns { ok: false, error: "OCCUPIED" }; playing after a win returns
{ ok: false, error: "GAME_OVER" }. Rejections must not change state. Use plain serializable RPC data.`,
    verify: async context => [await check("tic-tac-toe.behavior", async () => {
      using api = await context.connect<TicTacToeApi>(gadgetId(context, "Three in a Row"));
      const first = MutationSchema.parse(await api.play({ index: 0 }));
      const occupiedBefore = GameSchema.parse(await api.getGame());
      const occupied = MutationSchema.parse(await api.play({ index: 0 }));
      const occupiedAfter = GameSchema.parse(await api.getGame());
      const moves = [];
      for (const index of [3, 1, 4, 2]) {
        moves.push(MutationSchema.parse(await api.play({ index })));
      }
      const won = GameSchema.parse(await api.getGame());
      const postWin = MutationSchema.parse(await api.play({ index: 5 }));
      const stillWon = GameSchema.parse(await api.getGame());
      const reset = MutationSchema.parse(await api.reset());
      const fresh = GameSchema.parse(await api.getGame());
      const replay = [];
      for (const index of [0, 3, 1, 4, 2]) {
        replay.push(MutationSchema.parse(await api.play({ index })));
      }
      const final = GameSchema.parse(await api.getGame());
      return {
        pass: accepted(first) && rejected(occupied, "OCCUPIED") &&
          sameValue(occupiedBefore, occupiedAfter) && moves.every(accepted) && won.status === "won" &&
          won.winner === "X" && rejected(postWin, "GAME_OVER") && sameValue(won, stillWon) &&
          accepted(reset) && fresh.status === "playing" && fresh.winner === null &&
          fresh.currentPlayer === "X" && fresh.board.every(cell => cell === null) &&
          replay.every(accepted) && final.status === "won" && final.winner === "X",
        evidence: { occupied, won, postWin, fresh, final },
      };
    })],
  }],
  rubric: [
    { id: "game-state", criterion: "The winning result and completed board state are immediately clear.", weight: 2 },
    { id: "game-board", criterion: "The board is easy to scan and cells have generous interaction targets.", weight: 1 },
    { id: "game-accessibility", criterion: "X, O, and game status remain distinguishable without color.", weight: 1 },
    { id: "game-mobile", criterion: "The complete game remains comfortable to play at the mobile viewport.", weight: 1 },
  ],
};

const RsvpSummarySchema = z.object({
  statusTotals: z.object({ yes: z.number().int(), maybe: z.number().int(), no: z.number().int() }).strict(),
  guestTotals: z.object({ yes: z.number().int(), maybe: z.number().int(), no: z.number().int() }).strict(),
  capacity: z.object({ limit: z.number().int(), confirmedPeople: z.number().int(), remaining: z.number().int() }).strict(),
}).strict();
type RsvpSummary = z.infer<typeof RsvpSummarySchema>;
interface RsvpApi {
  setCapacity(input: { capacity: number }): Promise<Mutation>;
  respond(input: { person: string; status: "yes" | "maybe" | "no"; guests: number }): Promise<Mutation>;
  getSummary(): Promise<RsvpSummary>;
}

const rsvpTask: WorkshopEvalTask = {
  id: "event-rsvp-dashboard",
  title: "Event RSVP dashboard",
  expectation: "required",
  turns: [{
    prompt: `Build an event RSVP dashboard Gadget named exactly "Gather". It should make response and
capacity totals easy to scan, offer clear response feedback, and work well on phones. Expose this
stable plain-data server RPC:
- setCapacity({ capacity: non-negative integer }) -> { ok: true } | { ok: false, error: string }
- respond({ person: non-empty string, status: "yes" | "maybe" | "no", guests: non-negative integer })
  -> { ok: true } | { ok: false, error: string }. A later response for the same person replaces the
  earlier response rather than adding another.
- getSummary() -> { statusTotals: { yes: number, maybe: number, no: number }, guestTotals:
  { yes: number, maybe: number, no: number }, capacity: { limit: number, confirmedPeople: number,
  remaining: number } }. guestTotals count accompanying guests by status. confirmedPeople is each
  "yes" respondent plus their guests; remaining is limit minus confirmedPeople.
Negative guests must return { ok: false, error: "NEGATIVE_GUESTS" } without changing state. All RPC
inputs and results must be plain serializable data.`,
    verify: async context => [await check("rsvp.behavior", async () => {
      using api = await context.connect<RsvpApi>(gadgetId(context, "Gather"));
      const results = [
        MutationSchema.parse(await api.setCapacity({ capacity: 10 })),
        MutationSchema.parse(await api.respond({ person: "Ava", status: "yes", guests: 2 })),
        MutationSchema.parse(await api.respond({ person: "Ava", status: "maybe", guests: 1 })),
        MutationSchema.parse(await api.respond({ person: "Ben", status: "yes", guests: 3 })),
        MutationSchema.parse(await api.respond({ person: "Chen", status: "no", guests: 2 })),
      ];
      const before = RsvpSummarySchema.parse(await api.getSummary());
      const invalid = MutationSchema.parse(await api.respond({ person: "Dana", status: "yes", guests: -1 }));
      const after = RsvpSummarySchema.parse(await api.getSummary());
      return {
        pass: results.every(accepted) && rejected(invalid, "NEGATIVE_GUESTS") &&
          sameValue(before, after) && sameValue(after, {
            statusTotals: { yes: 1, maybe: 1, no: 1 },
            guestTotals: { yes: 3, maybe: 1, no: 2 },
            capacity: { limit: 10, confirmedPeople: 4, remaining: 6 },
          }),
        evidence: { invalid, summary: after },
      };
    })],
  }],
  rubric: [
    { id: "rsvp-hierarchy", criterion: "Response totals and remaining capacity are prominent and easy to compare.", weight: 2 },
    { id: "rsvp-status", criterion: "Going, maybe, and declined groups are clearly labelled and comparable.", weight: 1 },
    { id: "rsvp-accessibility", criterion: "Response statuses use labels or symbols in addition to color.", weight: 1 },
    { id: "rsvp-mobile", criterion: "Summary and response controls remain clear and usable on mobile.", weight: 1 },
  ],
};

const BoardSchema = z.object({
  columns: z.array(z.object({ id: z.string(), title: z.string(), wipLimit: z.number().int().positive().nullable() }).strict()),
  cards: z.array(z.object({ id: z.string(), title: z.string(), columnId: z.string() }).strict()),
}).strict();
type Board = z.infer<typeof BoardSchema>;
interface KanbanApi {
  configureColumns(input: { columns: { id: string; title: string }[] }): Promise<Mutation>;
  addCard(input: { id: string; title: string; columnId: string }): Promise<Mutation>;
  setWipLimit(input: { columnId: string; limit: number }): Promise<Mutation>;
  moveCard(input: { cardId: string; columnId: string }): Promise<Mutation>;
  getBoard(): Promise<Board>;
}

const kanbanTask: WorkshopEvalTask = {
  id: "kanban-wip-limits",
  title: "Kanban then WIP limits",
  expectation: "required",
  turns: [{
    prompt: `Create a Kanban Gadget named exactly "Delivery Board" with Todo, Doing, and Done columns.
Seed three cards through the Gadget's persistent data model: c1 "Write brief" in todo, c2 "Build
prototype" in todo, and c3 "Review copy" in doing. Make the board readable and usable on desktop
and mobile, with clear movement feedback. Expose this stable plain-data server RPC:
- configureColumns({ columns: Array<{ id: string, title: string }> }) -> mutation result
- addCard({ id: string, title: string, columnId: string }) -> mutation result
- getBoard() -> { columns: Array<{ id: string, title: string, wipLimit: positive integer | null }>,
  cards: Array<{ id: string, title: string, columnId: string }> }
A mutation result is exactly { ok: true } | { ok: false, error: string }. Use the column IDs todo,
doing, and done, preserve card IDs, and keep RPC data plain and serializable.`,
    verify: async context => [await check("kanban.seeded-board", async () => {
      using api = await context.connect<KanbanApi>(gadgetId(context, "Delivery Board"));
      const board = BoardSchema.parse(await api.getBoard());
      const locations = Object.fromEntries(board.cards.map(card => [card.id, card.columnId]));
      const titles = Object.fromEntries(board.cards.map(card => [card.id, card.title]));
      return {
        pass: board.columns.map(column => column.id).join(",") === "todo,doing,done" &&
          locations.c1 === "todo" && locations.c2 === "todo" && locations.c3 === "doing" &&
          titles.c1 === "Write brief" && titles.c2 === "Build prototype" && titles.c3 === "Review copy",
        evidence: board,
      };
    })],
  }, {
    prompt: `Keep the existing Delivery Board and all three cards. Add a WIP limit feature to its
plain-data RPC and UI. The Doing column should visibly show a limit of 2 and how much capacity is
used. Add these exact methods while preserving getBoard and all existing state:
- setWipLimit({ columnId: string, limit: positive integer }) ->
  { ok: true } | { ok: false, error: string }
- moveCard({ cardId: string, columnId: string }) ->
  { ok: true } | { ok: false, error: string }
If a move would exceed the destination limit, return { ok: false, error: "WIP_LIMIT" } and make no
state change. Successful later moves must still work. Keep inputs and results plain serializable data.`,
    verify: async context => [await check("kanban.wip-behavior", async () => {
      using api = await context.connect<KanbanApi>(gadgetId(context, "Delivery Board"));
      const preserved = BoardSchema.parse(await api.getBoard());
      const limit = MutationSchema.parse(await api.setWipLimit({ columnId: "doing", limit: 2 }));
      const firstMove = MutationSchema.parse(await api.moveCard({ cardId: "c1", columnId: "doing" }));
      const full = BoardSchema.parse(await api.getBoard());
      const blocked = MutationSchema.parse(await api.moveCard({ cardId: "c2", columnId: "doing" }));
      const afterBlocked = BoardSchema.parse(await api.getBoard());
      const freeSpace = MutationSchema.parse(await api.moveCard({ cardId: "c3", columnId: "done" }));
      const laterMove = MutationSchema.parse(await api.moveCard({ cardId: "c2", columnId: "doing" }));
      const final = BoardSchema.parse(await api.getBoard());
      const locations = Object.fromEntries(final.cards.map(card => [card.id, card.columnId]));
      const titles = Object.fromEntries(final.cards.map(card => [card.id, card.title]));
      return {
        pass: preserved.cards.length === 3 && accepted(limit) && accepted(firstMove) &&
          rejected(blocked, "WIP_LIMIT") && sameValue(full, afterBlocked) && accepted(freeSpace) &&
          accepted(laterMove) && locations.c1 === "doing" && locations.c2 === "doing" &&
          locations.c3 === "done" && titles.c1 === "Write brief" &&
          titles.c2 === "Build prototype" && titles.c3 === "Review copy" &&
          final.columns.find(column => column.id === "doing")?.wipLimit === 2,
        evidence: { blocked, final },
      };
    })],
  }],
  rubric: [
    { id: "kanban-hierarchy", criterion: "Columns, cards, and card status are easy to scan as a board.", weight: 2 },
    { id: "kanban-wip", criterion: "Doing capacity, its limit, and current usage are clearly visible.", weight: 2 },
    { id: "kanban-accessibility", criterion: "Column and capacity states remain understandable without color alone.", weight: 1 },
    { id: "kanban-mobile", criterion: "Cards can be read and moved in a practical mobile layout.", weight: 1 },
  ],
};

const ReadingLogSchema = z.object({
  books: z.array(z.object({ id: z.string(), title: z.string(), author: z.string(), progressPercent: z.number().min(0).max(100) }).strict()),
}).strict();
type ReadingLog = z.infer<typeof ReadingLogSchema>;
interface ReadingApi {
  addBook(input: { id: string; title: string; author: string; progressPercent: number }): Promise<Mutation>;
  getReadingLog(): Promise<ReadingLog>;
}
const PollSchema = z.object({
  options: z.array(z.object({ id: z.string(), label: z.string(), votes: z.number().int().nonnegative() }).strict()),
  totalVotes: z.number().int().nonnegative(),
}).strict();
type Poll = z.infer<typeof PollSchema>;
interface PollApi {
  setOptions(input: { options: { id: string; label: string }[] }): Promise<Mutation>;
  vote(input: { voterId: string; optionId: string }): Promise<Mutation>;
  getResults(): Promise<Poll>;
}

const readingPollTask: WorkshopEvalTask = {
  id: "reading-log-book-club-poll",
  title: "Reading log then separate Book Club Poll Gadget",
  expectation: "required",
  turns: [{
    prompt: `Create a reading log Gadget named exactly "Reading Log". Seed Dune by Frank Herbert at
40% progress and make reading progress easy to scan on desktop and mobile without depending only on
color. Expose this stable plain-data server RPC:
- addBook({ id: string, title: string, author: string, progressPercent: number from 0 to 100 }) ->
  { ok: true } | { ok: false, error: string }
- getReadingLog() -> { books: Array<{ id: string, title: string, author: string,
  progressPercent: number }> }
Use book ID "dune" and keep all RPC inputs and results plain serializable data.`,
    verify: async context => [await check("reading.seeded", async () => {
      using api = await context.connect<ReadingApi>(gadgetId(context, "Reading Log"));
      const log = ReadingLogSchema.parse(await api.getReadingLog());
      const dune = log.books.find(book => book.id === "dune");
      return { pass: dune?.title === "Dune" && dune.author === "Frank Herbert" && dune.progressPercent === 40, evidence: log };
    })],
  }, {
    prompt: `Keep the Reading Log and its Dune entry unchanged. Create a second, separate Gadget named
exactly "Book Club Poll" for choosing the next book; do not turn the reading log into the poll.
Give the poll options Dune (id "dune") and Piranesi (id "piranesi"), make current results and voting
feedback clear on desktop and mobile, and expose this stable plain-data server RPC on Book Club Poll:
- setOptions({ options: Array<{ id: string, label: string }> }) ->
  { ok: true } | { ok: false, error: string }
- vote({ voterId: string, optionId: string }) -> { ok: true } | { ok: false, error: string }.
  A later vote by the same voter replaces their earlier vote and counts only once.
- getResults() -> { options: Array<{ id: string, label: string, votes: non-negative integer }>,
  totalVotes: non-negative integer }
Keep all RPC inputs and results plain serializable data.`,
    verify: async context => [await check("reading-poll.separate-and-persistent", async () => {
      const readingId = gadgetId(context, "Reading Log");
      const pollId = gadgetId(context, "Book Club Poll");
      using reading = await context.connect<ReadingApi>(readingId);
      using poll = await context.connect<PollApi>(pollId);
      const log = ReadingLogSchema.parse(await reading.getReadingLog());
      const first = MutationSchema.parse(await poll.vote({ voterId: "sam", optionId: "dune" }));
      const replacement = MutationSchema.parse(await poll.vote({ voterId: "sam", optionId: "piranesi" }));
      const results = PollSchema.parse(await poll.getResults());
      const votes = Object.fromEntries(results.options.map(option => [option.id, option.votes]));
      const dune = log.books.find(book => book.id === "dune");
      return {
        pass: readingId !== pollId && dune?.title === "Dune" && dune.author === "Frank Herbert" &&
          dune.progressPercent === 40 && accepted(first) &&
          accepted(replacement) && results.totalVotes === 1 && votes.dune === 0 && votes.piranesi === 1,
        evidence: { readingLog: log, poll: results },
      };
    })],
  }],
  rubric: [
    { id: "reading-progress", criterion: "Book identity and reading progress are clear in the Reading Log.", weight: 1 },
    { id: "poll-results", criterion: "Poll options, selected choice, vote feedback, and current results are clear.", weight: 2 },
    { id: "reading-poll-distinction", criterion: "The two Gadgets have clear, task-appropriate identities rather than appearing interchangeable.", weight: 1 },
    { id: "reading-poll-mobile", criterion: "Both reading and voting workflows remain readable and usable on mobile.", weight: 1 },
  ],
};

const OrgChartSchema = z.object({
  people: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), managerId: z.string().nullable() }).strict()),
}).strict();
type OrgChart = z.infer<typeof OrgChartSchema>;
interface OrgChartApi {
  setPeople(input: { people: { id: string; name: string; role: string; managerId: string | null }[] }): Promise<Mutation>;
  movePerson(input: { personId: string; managerId: string | null }): Promise<Mutation>;
  getChart(): Promise<OrgChart>;
}

const orgChartTask: WorkshopEvalTask = {
  id: "org-chart",
  title: "Org chart",
  expectation: "frontier",
  turns: [{
    prompt: `Build an editable org chart Gadget named exactly "Org Chart". It should make reporting
hierarchy, roles, and move feedback clear on desktop and mobile, with connectors or other non-color
cues. Expose this stable plain-data server RPC:
- setPeople({ people: Array<{ id: string, name: string, role: string, managerId: string | null }> }) ->
  { ok: true } | { ok: false, error: string }
- movePerson({ personId: string, managerId: string | null }) ->
  { ok: true } | { ok: false, error: string }
- getChart() -> { people: Array<{ id: string, name: string, role: string,
  managerId: string | null }> }
Seed ceo/Alex/CEO at the root, eng/Blair/Engineering under ceo, and design/Casey/Design under ceo.
A move that creates a reporting cycle must return { ok: false, error: "CYCLE" } and leave the whole
chart unchanged. Keep RPC data plain and serializable.`,
    verify: async context => [await check("org-chart.behavior", async () => {
      using api = await context.connect<OrgChartApi>(gadgetId(context, "Org Chart"));
      const initial = OrgChartSchema.parse(await api.getChart());
      const initialById = Object.fromEntries(initial.people.map(person => [person.id, person]));
      const move = MutationSchema.parse(await api.movePerson({ personId: "design", managerId: "eng" }));
      const moved = OrgChartSchema.parse(await api.getChart());
      const cycle = MutationSchema.parse(await api.movePerson({ personId: "ceo", managerId: "design" }));
      const after = OrgChartSchema.parse(await api.getChart());
      return {
        pass: initial.people.length === 3 && initialById.ceo?.name === "Alex" &&
          initialById.ceo.role === "CEO" && initialById.ceo.managerId === null &&
          initialById.eng?.name === "Blair" && initialById.eng.role === "Engineering" &&
          initialById.eng.managerId === "ceo" && initialById.design?.name === "Casey" &&
          initialById.design.role === "Design" && initialById.design.managerId === "ceo" && accepted(move) &&
          moved.people.find(person => person.id === "design")?.managerId === "eng" &&
          rejected(cycle, "CYCLE") && sameValue(moved, after),
        evidence: { cycle, chart: after },
      };
    })],
  }],
  rubric: [
    { id: "org-hierarchy", criterion: "Reporting relationships and organizational levels are immediately legible.", weight: 2 },
    { id: "org-detail", criterion: "Names and roles are readable without obscuring the hierarchy.", weight: 1 },
    { id: "org-controls", criterion: "The visible editing controls make reporting-line changes understandable.", weight: 1 },
    { id: "org-mobile", criterion: "The chart offers a practical way to inspect the hierarchy on mobile.", weight: 1 },
  ],
};

const DependencySchema = z.object({
  nodes: z.array(z.object({ id: z.string(), label: z.string(), duration: z.number().int().nonnegative() }).strict()),
  edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
  criticalPath: z.object({ nodeIds: z.array(z.string()), duration: z.number().int().nonnegative() }).strict(),
}).strict();
type DependencyGraph = z.infer<typeof DependencySchema>;
interface DependencyApi {
  setGraph(input: {
    nodes: { id: string; label: string; duration: number }[];
    edges: { from: string; to: string }[];
  }): Promise<Mutation>;
  addDependency(input: { from: string; to: string }): Promise<Mutation>;
  getAnalysis(): Promise<DependencyGraph>;
}

const dependencyTask: WorkshopEvalTask = {
  id: "incident-dependency-diagram",
  title: "Incident dependency diagram",
  expectation: "frontier",
  turns: [{
    prompt: `Create an incident dependency diagram Gadget named exactly "Incident Dependency
Diagram". Make dependency direction and the critical path clear with labels or line treatments as
well as color, and provide a usable mobile inspection experience. Expose this stable plain-data RPC:
- setGraph({ nodes: Array<{ id: string, label: string, duration: non-negative integer }>,
  edges: Array<{ from: string, to: string }> }) -> { ok: true } | { ok: false, error: string }
- addDependency({ from: string, to: string }) -> { ok: true } | { ok: false, error: string }
- getAnalysis() -> { nodes: Array<{ id: string, label: string, duration: number }>,
  edges: Array<{ from: string, to: string }>, criticalPath: { nodeIds: string[], duration: number } }
Seed nodes detect/Detect/5, api/API/3, database/Database/7, recover/Recover/4 and edges detect->api,
api->recover, detect->database, database->recover. Critical path duration is the sum of node durations.
A dangling edge must return { ok: false, error: "DANGLING_NODE" }; a cycle must return
{ ok: false, error: "CYCLE" }. Both rejections leave the graph unchanged. Use plain RPC data.`,
    verify: async context => [await check("dependency.behavior", async () => {
      using api = await context.connect<DependencyApi>(gadgetId(context, "Incident Dependency Diagram"));
      const initial = DependencySchema.parse(await api.getAnalysis());
      const dangling = MutationSchema.parse(await api.addDependency({ from: "missing", to: "recover" }));
      const afterDangling = DependencySchema.parse(await api.getAnalysis());
      const cycle = MutationSchema.parse(await api.addDependency({ from: "recover", to: "detect" }));
      const afterCycle = DependencySchema.parse(await api.getAnalysis());
      const edges = new Set(initial.edges.map(edge => `${edge.from}->${edge.to}`));
      const nodes = Object.fromEntries(initial.nodes.map(node => [node.id, node]));
      return {
        pass: initial.nodes.length === 4 && edges.size === 4 && edges.has("detect->api") &&
          edges.has("api->recover") && edges.has("detect->database") && edges.has("database->recover") &&
          nodes.detect?.label === "Detect" && nodes.detect.duration === 5 &&
          nodes.api?.label === "API" && nodes.api.duration === 3 &&
          nodes.database?.label === "Database" && nodes.database.duration === 7 &&
          nodes.recover?.label === "Recover" && nodes.recover.duration === 4 &&
          initial.criticalPath.nodeIds.join(",") === "detect,database,recover" &&
          initial.criticalPath.duration === 16 && rejected(dangling, "DANGLING_NODE") &&
          sameValue(initial, afterDangling) && rejected(cycle, "CYCLE") && sameValue(initial, afterCycle),
        evidence: { dangling, cycle, analysis: afterCycle },
      };
    })],
  }],
  rubric: [
    { id: "dependency-direction", criterion: "Dependency direction and incident sequence are easy to follow.", weight: 2 },
    { id: "dependency-critical", criterion: "The critical path and its duration are clearly identified.", weight: 2 },
    { id: "dependency-accessibility", criterion: "Nodes, edges, and critical status are distinguishable without color alone.", weight: 1 },
    { id: "dependency-mobile", criterion: "The graph can be inspected meaningfully at the mobile viewport.", weight: 1 },
  ],
};

const WhiteboardSchema = z.object({
  notes: z.array(z.object({
    id: z.string(), text: z.string(), color: z.string(), x: z.number(), y: z.number(),
  }).strict()),
}).strict();
type Whiteboard = z.infer<typeof WhiteboardSchema>;
interface WhiteboardApi {
  createNote(input: { id: string; text: string; color: string; x: number; y: number }): Promise<Mutation>;
  moveNote(input: { id: string; x: number; y: number }): Promise<Mutation>;
  deleteNote(input: { id: string }): Promise<Mutation>;
  getWhiteboard(): Promise<Whiteboard>;
}

const whiteboardTask: WorkshopEvalTask = {
  id: "sticky-note-whiteboard",
  title: "Sticky-note whiteboard",
  expectation: "frontier",
  turns: [{
    prompt: `Build a spatial sticky-note whiteboard Gadget named exactly "Sticky-note Whiteboard".
Notes should be easy to create, read, move, and delete, with clear selected/drag feedback and a
workable mobile layout. Text must distinguish notes even when colors are not visible. Expose this
stable plain-data server RPC:
- createNote({ id: string, text: string, color: string, x: number, y: number }) -> mutation result
- moveNote({ id: string, x: number, y: number }) -> mutation result
- deleteNote({ id: string }) -> mutation result
- getWhiteboard() -> { notes: Array<{ id: string, text: string, color: string, x: number, y: number }> }
A mutation result is { ok: true } | { ok: false, error: string }. Moving or deleting an unknown ID
must return { ok: false, error: "UNKNOWN_NOTE" } and preserve all notes. Keep RPC data plain.`,
    verify: async context => [await check("whiteboard.behavior", async () => {
      using api = await context.connect<WhiteboardApi>(gadgetId(context, "Sticky-note Whiteboard"));
      const created = [
        MutationSchema.parse(await api.createNote({ id: "n1", text: "Call supplier", color: "yellow", x: 20, y: 30 })),
        MutationSchema.parse(await api.createNote({ id: "n2", text: "Update status page", color: "blue", x: 180, y: 90 })),
      ];
      const move = MutationSchema.parse(await api.moveNote({ id: "n1", x: 75, y: 110 }));
      const moved = WhiteboardSchema.parse(await api.getWhiteboard());
      const remove = MutationSchema.parse(await api.deleteNote({ id: "n2" }));
      const remaining = WhiteboardSchema.parse(await api.getWhiteboard());
      const invalid = MutationSchema.parse(await api.moveNote({ id: "missing", x: 0, y: 0 }));
      const after = WhiteboardSchema.parse(await api.getWhiteboard());
      const n1 = moved.notes.find(note => note.id === "n1");
      return {
        pass: created.every(accepted) && accepted(move) && moved.notes.length === 2 &&
          n1?.text === "Call supplier" && n1.color === "yellow" && n1.x === 75 && n1.y === 110 &&
          accepted(remove) && remaining.notes.length === 1 && remaining.notes.at(0)?.id === "n1" &&
          rejected(invalid, "UNKNOWN_NOTE") && sameValue(remaining, after),
        evidence: { invalid, notes: after },
      };
    })],
  }],
  rubric: [
    { id: "whiteboard-spatial", criterion: "The canvas and note positions communicate a useful spatial workspace.", weight: 2 },
    { id: "whiteboard-controls", criterion: "Visible controls for creating, selecting, moving, and deleting notes are discoverable.", weight: 2 },
    { id: "whiteboard-accessibility", criterion: "Notes remain identifiable by readable text and state cues without color alone.", weight: 1 },
    { id: "whiteboard-mobile", criterion: "The board offers a practical way to navigate and manipulate notes on mobile.", weight: 1 },
  ],
};

/** Initial outcome corpus expected to exercise core Workshop capabilities. */
export const requiredTasks: readonly WorkshopEvalTask[] = [
  habitTask,
  expenseTask,
  inventoryTask,
  ticTacToeTask,
  rsvpTask,
  kanbanTask,
  readingPollTask,
];

/** Initial exploratory outcome corpus for more demanding spatial and graph applications. */
export const frontierTasks: readonly WorkshopEvalTask[] = [
  orgChartTask,
  dependencyTask,
  whiteboardTask,
];

/** Live matrix configuration parsed strictly from the eval environment. */
export function workshopEvalMatrix(environment: NodeJS.ProcessEnv = process.env): {
  models: string[];
  trials: number;
  runId: string;
} {
  const trialsText = environment.WORKSHOP_EVAL_TRIALS ?? "10";
  if (!/^[1-9][0-9]*$/.test(trialsText)) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  const trials = Number(trialsText);
  if (!Number.isSafeInteger(trials)) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive safe integer");
  }

  const modelsText = environment.WORKSHOP_EVAL_MODELS ?? DEFAULT_MODELS.join(",");
  const models = modelsText.split(",").map(model => model.trim());
  if (models.length === 0 || models.some(model => model === "")) {
    throw new Error("WORKSHOP_EVAL_MODELS must be a non-empty comma-separated model list");
  }
  if (new Set(models).size !== models.length) {
    throw new Error("WORKSHOP_EVAL_MODELS must not contain duplicate models");
  }
  const configuredRunId = environment.WORKSHOP_EVAL_RUN_ID?.trim();
  return { models, trials, runId: configuredRunId || randomUUID() };
}
