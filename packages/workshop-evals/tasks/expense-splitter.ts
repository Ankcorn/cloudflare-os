import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const SettlementSchema = z.object({
  balances: z.array(z.object({ person: z.string(), net: z.number() }).strict()),
  transfers: z.array(
      z.object({ from: z.string(), to: z.string(), amount: z.number().positive() }).strict()),
}).strict();

interface SplitterApi {
  addExpense(input: { payer: string; amountCents: number; participants: string[] }):
    Promise<{ ok: true } | { ok: false; error: string }>;
  settle(): Promise<z.infer<typeof SettlementSchema>>;
}

/**
 * Whole-cent net for one person, so a float-based implementation still compares exactly, and null
 * when they are absent entirely — NaN would be dropped from the JSON evidence for that failure.
 */
function net(settlement: z.infer<typeof SettlementSchema>, person: string): number | null {
  const balance = settlement.balances.find(entry => entry.person === person);
  return balance === undefined ? null : Math.round(balance.net);
}

export default defineEvalTask({
  id: "expense-splitter",
  title: "Expense splitter",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Split" for splitting shared expenses between friends.
Show who owes what, and make it comfortable to use on a phone.

It also needs a stable server RPC taking and returning plain data, so I can verify it:
- addExpense({ payer: string, amountCents: integer > 0, participants: string[] }) ->
  { ok: true } | { ok: false, error: string }. The payer paid amountCents on behalf of everyone in
  participants, split evenly. An empty participants list returns { ok: false, error: "NO_PARTICIPANTS" }.
- settle() -> { balances: Array<{ person: string, net: number }>,
  transfers: Array<{ from: string, to: string, amount: number }> }. All amounts are in cents. A
  person's net is positive when they are owed money and negative when they owe. transfers is a set
  of payments that settles everyone up.`,
    verify: async verifier => {
      await verifier.check("even-split-balances", async () => {
        using api = await verifier.connect<SplitterApi>("Split");
        // Ana pays 3000 for all three; Ben pays 1500 for himself and Cy.
        // Ana: +3000 - 1000 = +2000. Ben: +1500 - 1000 - 750 = -250. Cy: -1000 - 750 = -1750.
        const added = [
          await api.addExpense({ payer: "Ana", amountCents: 3000, participants: ["Ana", "Ben", "Cy"] }),
          await api.addExpense({ payer: "Ben", amountCents: 1500, participants: ["Ben", "Cy"] }),
        ];
        const settlement = SettlementSchema.parse(await api.settle());
        const expected = { Ana: 2000, Ben: -250, Cy: -1750 };
        const actual = Object.fromEntries(
            Object.keys(expected).map(person => [person, net(settlement, person)]));
        return {
          pass: added.every(result => result.ok) &&
            Object.entries(expected).every(([person, value]) => actual[person] === value),
          evidence: { expected, actual },
        };
      });

      await verifier.check("transfers-clear-every-balance", async () => {
        using api = await verifier.connect<SplitterApi>("Split");
        const settlement = SettlementSchema.parse(await api.settle());
        const cleared = new Map(settlement.balances.map(balance => [balance.person, balance.net]));
        for (const transfer of settlement.transfers) {
          cleared.set(transfer.from, (cleared.get(transfer.from) ?? 0) + transfer.amount);
          cleared.set(transfer.to, (cleared.get(transfer.to) ?? 0) - transfer.amount);
        }
        const residuals = [...cleared].map(([person, value]) => [person, Math.round(value)] as const);
        return {
          pass: residuals.every(([, value]) => value === 0),
          evidence: Object.fromEntries(residuals),
        };
      });

      await verifier.check("rejects-empty-participants", async () => {
        using api = await verifier.connect<SplitterApi>("Split");
        const result = await api.addExpense({ payer: "Ana", amountCents: 500, participants: [] });
        return { pass: !result.ok && result.error === "NO_PARTICIPANTS", evidence: result };
      });
    },
  }],
});
