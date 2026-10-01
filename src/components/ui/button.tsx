import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border-2 text-[15px] font-extrabold leading-tight transition-colors disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-teal",
  {
    variants: {
      variant: {
        default: "border-ink bg-ink text-white hover:border-teal hover:bg-teal",
        accent: "border-ink bg-yellow text-ink shadow-hard-sm hover:bg-white",
        destructive: "border-red-text bg-transparent text-red-text hover:bg-red-text hover:text-white",
        outline: "border-ink bg-transparent text-ink hover:bg-paper-alt",
        secondary: "border-ink bg-paper-alt text-ink hover:bg-yellow",
        ghost: "border-transparent bg-transparent text-ink hover:bg-paper-alt",
        link: "border-transparent text-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 px-5 py-2.5 has-[>svg]:px-4",
        sm: "min-h-9 gap-1.5 px-3.5 py-1.5 text-sm has-[>svg]:px-3",
        lg: "min-h-12 px-6 py-3 has-[>svg]:px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
