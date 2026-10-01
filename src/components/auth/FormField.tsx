import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface FormFieldProps {
  id: string;
  name?: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  error?: string;
  hint?: ReactNode;
  endContent?: ReactNode;
}

export function FormField({
  id,
  name,
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
  error,
  hint,
  endContent,
}: FormFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name ?? id}
          type={type}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn("input", endContent && "pr-12")}
        />
        {endContent}
      </div>
      {error ? (
        <p id={errorId} className="text-red-text mt-1.5 flex items-center gap-1.5 text-sm font-semibold">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        hint
      )}
    </div>
  );
}
