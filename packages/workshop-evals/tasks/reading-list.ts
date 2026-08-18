import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const BookSchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  finished: z.boolean(),
}).strict();

const TaggedBookSchema = BookSchema.extend({ tags: z.array(z.string()) }).strict();

interface ReadingListApi {
  add(input: { title: string; author: string }): Promise<{ id: string }>;
  finish(input: { id: string }): Promise<{ ok: boolean }>;
  list(): Promise<z.infer<typeof BookSchema>[]>;
}

interface TaggedReadingListApi extends ReadingListApi {
  list(): Promise<z.infer<typeof TaggedBookSchema>[]>;
  tag(input: { id: string; tag: string }): Promise<{ ok: boolean }>;
  search(input: { tag: string }): Promise<z.infer<typeof TaggedBookSchema>[]>;
}

/**
 * Two prompts against one Gadget, where the second adds a feature and the first turn's contract is
 * asserted again afterwards. The interesting failure is not building tagging — it is breaking
 * `finish` or `list` while building tagging.
 */
export default defineEvalTask({
  id: "reading-list",
  title: "Reading list, then tagging",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Shelf" for tracking books I want to read. I should be
able to add a book, see the list, and mark one as finished.

It also needs a stable server RPC taking and returning plain data, so I can verify it:
- add({ title: string, author: string }) -> { id: string } with a unique id
- finish({ id: string }) -> { ok: boolean }, false when the id is unknown
- list() -> Array<{ id: string, title: string, author: string, finished: boolean }>`,
    verify: async verifier => {
      await verifier.check("add-list-finish", async () => {
        using api = await verifier.connect<ReadingListApi>("Shelf");
        const dune = await api.add({ title: "Dune", author: "Herbert" });
        await api.add({ title: "Solaris", author: "Lem" });
        const finished = await api.finish({ id: dune.id });
        const unknown = await api.finish({ id: "no-such-book" });
        const books = z.array(BookSchema).parse(await api.list());
        return {
          pass: finished.ok && !unknown.ok && books.length === 2 &&
            books.find(book => book.id === dune.id)?.finished === true &&
            books.find(book => book.title === "Solaris")?.finished === false,
          evidence: { books, finished, unknown },
        };
      });
    },
  }, {
    prompt: `Now let me organise the shelf with tags. Add to the same Gadget:
- tag({ id: string, tag: string }) -> { ok: boolean }, false when the id is unknown. A book can
  carry several tags, and tagging with the same tag twice changes nothing.
- search({ tag: string }) -> the same book objects, filtered to those carrying that tag
- list() now also returns a tags: string[] field on every book
Keep everything that already worked working, and surface tags in the UI.`,
    verify: async verifier => {
      await verifier.check("tagging", async () => {
        using api = await verifier.connect<TaggedReadingListApi>("Shelf");
        const book = await api.add({ title: "Piranesi", author: "Clarke" });
        await api.tag({ id: book.id, tag: "fiction" });
        await api.tag({ id: book.id, tag: "fiction" });
        await api.tag({ id: book.id, tag: "favourite" });
        const unknown = await api.tag({ id: "no-such-book", tag: "fiction" });
        const found = z.array(TaggedBookSchema).parse(await api.search({ tag: "favourite" }));
        const tags = found.at(0)?.tags ?? [];
        return {
          pass: !unknown.ok && found.length === 1 && found.at(0)?.id === book.id &&
            tags.filter(tag => tag === "fiction").length === 1 && tags.includes("favourite"),
          evidence: { found, unknown },
        };
      });

      // The point of the task: the first turn's contract must still hold.
      await verifier.check("original-contract-survives", async () => {
        using api = await verifier.connect<TaggedReadingListApi>("Shelf");
        const book = await api.add({ title: "Ubik", author: "Dick" });
        const finished = await api.finish({ id: book.id });
        const unknown = await api.finish({ id: "no-such-book" });
        const books = z.array(TaggedBookSchema).parse(await api.list());
        return {
          pass: finished.ok && !unknown.ok &&
            books.find(entry => entry.id === book.id)?.finished === true &&
            books.every(entry => Array.isArray(entry.tags)),
          evidence: { books, finished, unknown },
        };
      });
    },
  }],
});
