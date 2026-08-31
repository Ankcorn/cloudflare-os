import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) =>
    ({ component, props, children }),
  Section: "Section",
}));

const { default: designStudioConfigurator } = await import(
  "../src/configurator/design-studio-configurator-ui.js"
);

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
