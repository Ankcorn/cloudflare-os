import { useState, FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import { PublicApi } from "@gadgets/workshop-shared/api";
import { Hexagon } from "@phosphor-icons/react";
import { Input, Button, Banner } from "@cloudflare/kumo";
import { hashPassword } from "./passwordHash";
import { useServerConfig, useSiteName } from "./ServerConfigContext";
import { useDocumentTitle } from "./useDocumentTitle";
import OAuthButtons from "./components/auth/OAuthButtons";

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>;
  // Username to prefill, from the deploy wizard's setup link. Locked (field disabled) when a
  // setup token is also present, since the token only unlocks that specific username.
  initialUsername?: string;
  // One-time setup token from the setup link's URL fragment. Passed to createAccount() to claim
  // a reserved admin username; also lets the form show while signups are closed.
  setupToken?: string;
}

export default function SignupPage({ rpcStub, initialUsername, setupToken }: SignupPageProps) {
  const serverConfig = useServerConfig();
  const siteName = useSiteName();
  useDocumentTitle("Create account");
  const authVendors = serverConfig?.authVendors ?? [];
  // A setup token can create the admin account even while signups are closed, so treat signups
  // as open for this visit (and suppress the signups-closed banner).
  const signupsEnabled = (serverConfig?.signupsEnabled ?? true) || !!setupToken;
  // The password create-account form requires both password auth AND open signups.
  const passwordAuthEnabled = (serverConfig?.passwordAuthEnabled ?? true) && signupsEnabled;
  const [username, setUsername] = useState(initialUsername ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameLocked = !!initialUsername && !!setupToken;

  // Matches the server's normalizeUsername() so the form never accepts a name the server rejects.
  const usernameError =
    username && !/^[a-z][a-z0-9_]*$/.test(username)
      ? "Lowercase letters, numbers, and underscores, starting with a letter"
      : undefined;

  const passwordError =
    password && password.length < 8
      ? "Must be at least 8 characters"
      : undefined;

  const confirmError =
    confirmPassword && confirmPassword !== password
      ? "Passwords do not match"
      : undefined;

  const canSubmit =
    username &&
    password &&
    confirmPassword &&
    !usernameError &&
    !passwordError &&
    !confirmError &&
    !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    try {
      const passwordHash = await hashPassword(username, password);
      const token = await rpcStub.createAccount(
        username,
        username,
        passwordHash,
        setupToken,
      );
      if (token) {
        localStorage.setItem("authToken", token);
        window.location.href = "/";
      } else {
        setError("Username already exists");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account creation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-kumo-base px-4 relative overflow-hidden">
      {/* Dot grid — fades from top to bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
        }}
      />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-kumo-brand mb-3">
            <Hexagon size={20} className="text-white" weight="bold" />
          </div>
          <h1 className="text-xl font-semibold text-kumo-default">
            {siteName}
          </h1>
          <p className="text-sm text-kumo-subtle mt-1">Create your account</p>
        </div>

        {!signupsEnabled && (
          <Banner
            variant="default"
            title="Signups are closed"
            className="mb-4"
          >
            New account registration is currently disabled on this deployment.
          </Banner>
        )}

        {passwordAuthEnabled && (
          <>
            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus={!usernameLocked}
                autoComplete="username"
                disabled={loading || usernameLocked}
                placeholder="your_username"
                error={usernameError}
              />

              <Input
                type="password"
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={usernameLocked}
                autoComplete="new-password"
                disabled={loading}
                placeholder="••••••••"
                error={passwordError}
              />

              <Input
                type="password"
                label="Confirm Password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading}
                placeholder="••••••••"
                error={confirmError}
              />

              {error && <Banner variant="error" title={error} />}

              <Button
                type="submit"
                variant="primary"
                disabled={!canSubmit}
                loading={loading}
                className="w-full justify-center"
              >
                Create account
              </Button>
            </form>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? "mt-6" : ""}>
            {passwordAuthEnabled && (
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">or</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            )}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} />
          </div>
        )}

        {passwordAuthEnabled && (
          <p className="text-center text-sm text-kumo-subtle mt-6">
            Already have an account?{" "}
            <Link to="/" className="text-kumo-brand hover:underline font-medium">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
