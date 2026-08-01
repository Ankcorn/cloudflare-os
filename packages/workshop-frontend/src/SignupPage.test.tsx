// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { PublicApi, ServerConfig } from "@gadgets/workshop-shared/api";
import { useServerConfig } from "./ServerConfigContext";
import { hashPassword } from "./passwordHash";
import SignupPage from "./SignupPage";

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: vi.fn<typeof useServerConfig>(),
  useSiteName: () => "gadgets",
}));
vi.mock("./passwordHash", () => ({ hashPassword: vi.fn<typeof hashPassword>() }));
vi.mock("./components/auth/OAuthButtons", () => ({ default: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: unknown }) => <a href="/">{props.children as never}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    authVendors: [],
    passwordAuthEnabled: true,
    cloudflareLimitsEnabled: false,
    signupsEnabled: true,
    siteName: "gadgets",
    announcement: "",
    banner: "",
    bannerColor: "neutral" as ServerConfig["bannerColor"],
    accentColor: "",
    ...overrides,
  };
}

describe("SignupPage", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  function render(element: React.ReactElement) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(element));
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function inputs(): HTMLInputElement[] {
    return [...container!.querySelectorAll("input")];
  }

  async function submitForm() {
    await act(async () => {
      container!.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("prefills and locks the username from the setup link, and passes the setup token to " +
      "createAccount", async () => {
    vi.mocked(useServerConfig).mockReturnValue(serverConfig());
    vi.mocked(hashPassword).mockResolvedValue(PASSWORD_HASH);
    const createAccount = vi.fn<PublicApi["createAccount"]>().mockResolvedValue(null);
    const rpcStub = { createAccount } as unknown as RpcStub<PublicApi>;

    render(<SignupPage rpcStub={rpcStub} initialUsername="admin" setupToken="s3cret" />);

    const [username, password, confirm] = inputs();
    expect(username.value).toBe("admin");
    expect(username.disabled).toBe(true);

    setInputValue(password, "password123");
    setInputValue(confirm, "password123");
    await submitForm();

    expect(createAccount).toHaveBeenCalledWith("admin", "admin", PASSWORD_HASH, "s3cret");
  });

  it("shows the form despite closed signups when a setup token is present", () => {
    vi.mocked(useServerConfig).mockReturnValue(serverConfig({ signupsEnabled: false }));
    const rpcStub = {} as unknown as RpcStub<PublicApi>;

    render(<SignupPage rpcStub={rpcStub} initialUsername="admin" setupToken="s3cret" />);
    expect(container!.querySelector("form")).not.toBeNull();
    expect(container!.textContent).not.toContain("Signups are closed");

    act(() => root!.unmount());
    container!.remove();

    render(<SignupPage rpcStub={rpcStub} />);
    expect(container!.querySelector("form")).toBeNull();
    expect(container!.textContent).toContain("Signups are closed");
  });

  it("renders a thrown reservation error in the banner", async () => {
    vi.mocked(useServerConfig).mockReturnValue(serverConfig());
    vi.mocked(hashPassword).mockResolvedValue(PASSWORD_HASH);
    const message = "This username is reserved for the deployment administrator. Use the " +
        "setup link from your deployment's success page to claim it.";
    const createAccount = vi.fn<PublicApi["createAccount"]>().mockRejectedValue(new Error(message));
    const rpcStub = { createAccount } as unknown as RpcStub<PublicApi>;

    render(<SignupPage rpcStub={rpcStub} />);

    const [username, password, confirm] = inputs();
    setInputValue(username, "admin");
    setInputValue(password, "password123");
    setInputValue(confirm, "password123");
    await submitForm();

    expect(container!.textContent).toContain(message);
  });
});
