import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) =>
    ({ component, props, children }),
  Autocomplete: "Autocomplete",
  Field: "Field",
  Section: "Section",
}));

const [
  { default: instanceConfigurator },
  { default: designStudioConfigurator },
  { default: programConfigurator },
  { default: listConfigurator },
] = await Promise.all([
  import("../src/configurator/instance-configurator-ui.js"),
  import("../src/configurator/design-studio-configurator-ui.js"),
  import("../src/configurator/program-configurator-ui.js"),
  import("../src/configurator/list-configurator-ui.js"),
]);

const ORIGIN_A = "https://123-abc-456.mktorest.com";
const ORIGIN_B = "https://789-def-012.mktorest.com";

describe("Marketo configurator resource URLs", () => {
  it.each([
    ["instance", instanceConfigurator, "/_resource/instance", {}],
    ["Design Studio", designStudioConfigurator, "/_resource/design-studio", {}],
  ])("keeps a prefilled %s resource on its account instance", async (_name, spec, path, values) => {
    let ui = { resourceUrl: vi.fn().mockResolvedValue(`${ORIGIN_A}${path}`) };

    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_A}${path}`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).resolves.toEqual(values);
    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_A}${path}/`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).resolves.toEqual(values);
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(`${ORIGIN_A}${path}`);

    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_B}${path}`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).rejects.toThrow(/different Marketo instance/i);
  });

  it.each([
    ["program", programConfigurator, "program", "programId", "42"],
    ["static list", listConfigurator, "list", "listId", "73"],
  ])("keeps a prefilled %s on its account instance", async (_name, spec, kind, key, id) => {
    let ui = { resourceUrl: vi.fn((selectedId: string) =>
      Promise.resolve(`${ORIGIN_A}/_resource/${kind}/${selectedId}`)) };
    let path = `/_resource/${kind}/${id}`;
    let values = { [key]: id };

    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_A}${path}`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).resolves.toEqual(values);
    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_A}${path}/`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).resolves.toEqual(values);
    await expect(spec.resourceUrl({ values, ui } as never)).resolves.toBe(`${ORIGIN_A}${path}`);

    await expect(spec.initialValuesFromResourceUrl!({
      resourceUrl: `${ORIGIN_B}${path}`,
      resourceUrlPattern: "https://*",
      ui,
    } as never)).rejects.toThrow(/different Marketo instance/i);
  });
});

describe("Design Studio configurator", () => {
  it("discloses its complete mutation and deletion authority", () => {
    let rendered = JSON.stringify(designStudioConfigurator.render());

    expect(rendered).toMatch(/create or clone/i);
    expect(rendered).toMatch(/content and metadata/i);
    expect(rendered).toMatch(/publish.*propagate/i);
    expect(rendered).toMatch(/permanently discard/i);
    expect(rendered).toMatch(/permanently delete/i);
  });
});
