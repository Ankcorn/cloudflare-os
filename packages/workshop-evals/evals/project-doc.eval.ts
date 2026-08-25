import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const DocumentSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  // Null means the document was created but never written to, which is distinct from empty.
  blocks: z.array(z.object({
    id: z.string(),
    html: z.string(),
    version: z.number().int().nonnegative(),
  }).loose()).nullable(),
}).loose();

type Document = z.infer<typeof DocumentSchema>;

interface DocsApi {
  getDocument(): Promise<Document>;
}

const TITLE = "Harbour Refit";

function documentHtml(document: Document): string {
  return (document.blocks ?? []).map(block => block.html).join("\n");
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Docs are a standard platform output. The system prompt advertises the shipped blueprint, and a
 * real Doc appears on the outputs page and supports the collaborative Docs RPC. A custom notes
 * Gadget lacks both properties.
 */
const task = defineEvalTask({
  id: "project-doc",
  turns: [{
    prompt: `I'm kicking off a project called Harbour Refit. Set me up a doc named exactly
"${TITLE}" for my running notes on it.

Start it off with a heading for the project and three bullet points, one each for scope, budget and
timeline. Put a sentence of placeholder detail under each. I'll replace them as things firm up.`,
    verify: async verifier => {
      await verifier.check("is-presented-as-a-document-output", async () => {
        const doc = verifier.workpieces.find(workpiece => workpiece.title === TITLE);
        return {
          pass: doc?.output?.id === "document",
          evidence: verifier.workpieces.map(workpiece =>
            ({ title: workpiece.title, output: workpiece.output ?? null })),
        };
      });

      await verifier.check("answers-the-docs-contract-with-real-content", async () => {
        using api = await verifier.connect<DocsApi>(TITLE);
        const document = DocumentSchema.parse(await api.getDocument());
        const html = documentHtml(document);
        const listItems = [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi)]
            .map(match => plainText(match[1] ?? ""));
        const headings = [...html.matchAll(/<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi)]
            .map(match => plainText(match[1] ?? ""));
        const requiredItems = ["scope", "budget", "timeline"];
        const completeItems = requiredItems.filter(required =>
          listItems.some(item => item.includes(required) &&
            item.length >= required.length + 12 && /[.!?]/.test(item)));
        return {
          pass: document.revision >= 1 && document.blocks !== null &&
            document.title === TITLE &&
            headings.some(heading => heading.includes("harbour") && heading.includes("refit")) &&
            listItems.length === 3 && completeItems.length === requiredItems.length,
          evidence: {
            revision: document.revision,
            title: document.title,
            blockCount: document.blocks?.length ?? null,
            listItems,
            headings,
            completeItems,
          },
        };
      });

    },
  }],
});

defineTaskEval(task);
