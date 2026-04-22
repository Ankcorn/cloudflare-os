import { useState, FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import { PublicApi } from "@gadgets/workshop-shared/api";
import { Hexagon } from "@phosphor-icons/react";
import { Input, Button, Banner } from "@cloudflare/kumo";
import { hashPassword } from "./passwordHash";

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>;
}

export default function SignupPage({ rpcStub }: SignupPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameError =
    username && !/^[a-z0-9_-]+$/i.test(username)
      ? "Letters, numbers, underscores, and hyphens only"
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
            Gadgets Workshop
          </h1>
          <p className="text-sm text-kumo-subtle mt-1">Create your account</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={loading}
            placeholder="your-username"
            error={usernameError}
          />

          <Input
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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

        <p className="text-center text-sm text-kumo-subtle mt-6">
          Already have an account?{" "}
          <Link to="/" className="text-kumo-brand hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
