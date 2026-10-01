import React, { useState } from "react";
import { FormField } from "@/components/auth/FormField";
import { PasswordToggle } from "@/components/auth/PasswordToggle";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";

// Keep in sync with MIN_PASSWORD_LENGTH in src/lib/auth.ts and minimum_password_length in supabase/config.toml.
const MIN_PASSWORD_LENGTH = 8;

interface Props {
  serverError?: string | null;
}

export default function ResetPasswordForm({ serverError }: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string }>({});

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD_LENGTH)
      next.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    if (!confirmPassword) next.confirmPassword = "Please confirm your password";
    else if (password !== confirmPassword) next.confirmPassword = "Passwords do not match";
    setErrors(next);
    if (Object.keys(next).length > 0) e.preventDefault();
  }

  return (
    <form method="POST" action="/api/auth/reset-password" className="space-y-5" onSubmit={handleSubmit} noValidate>
      <FormField
        id="password"
        label="New password"
        type={showPassword ? "text" : "password"}
        value={password}
        onChange={(v) => {
          setPassword(v);
          setErrors((prev) => ({ ...prev, password: undefined }));
        }}
        placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
        autoComplete="new-password"
        error={errors.password}
        endContent={
          <PasswordToggle
            visible={showPassword}
            onToggle={() => {
              setShowPassword(!showPassword);
            }}
          />
        }
      />
      <FormField
        id="confirmPassword"
        name="confirmPassword"
        label="Confirm new password"
        type={showPassword ? "text" : "password"}
        value={confirmPassword}
        onChange={(v) => {
          setConfirmPassword(v);
          setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
        }}
        placeholder="Re-enter your password"
        autoComplete="new-password"
        error={errors.confirmPassword}
      />
      <ServerError message={serverError} />
      <SubmitButton pendingText="Saving…">Set new password</SubmitButton>
    </form>
  );
}
