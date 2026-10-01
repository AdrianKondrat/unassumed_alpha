import React, { useState } from "react";
import { FormField } from "@/components/auth/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";

interface Props {
  serverError?: string | null;
}

export default function ForgotPasswordForm({ serverError }: Props) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      e.preventDefault();
      setError(email.trim() ? "Enter a valid email address" : "Email is required");
    }
  }

  return (
    <form method="POST" action="/api/auth/forgot-password" className="space-y-5" onSubmit={handleSubmit} noValidate>
      <FormField
        id="email"
        type="email"
        label="Email"
        value={email}
        onChange={(v) => {
          setEmail(v);
          setError(undefined);
        }}
        placeholder="you@your-next-thing.com"
        autoComplete="email"
        error={error}
      />
      <ServerError message={serverError} />
      <SubmitButton pendingText="Sending…">Send reset link</SubmitButton>
    </form>
  );
}
