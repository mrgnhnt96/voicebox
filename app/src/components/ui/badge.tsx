import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded border px-1.5 py-px font-mono text-[10.5px] font-medium uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-accent/30 text-accent',
        secondary: 'border-input text-muted-foreground',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
        outline: 'text-foreground',
        warning: 'border-transparent bg-warning/15 text-warning',
        success: 'border-transparent bg-success/15 text-success',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
