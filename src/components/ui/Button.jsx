import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Primary: action blue with an ink outline and a hard shadow it presses into.
        default: 'border-[1.5px] border-ink bg-action text-white shadow-hard hover:bg-action-pressed',
        destructive: 'border-[1.5px] border-ink bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border-[1.5px] border-ink bg-card text-foreground hover:bg-paper',
        secondary: 'border border-hairline bg-card text-foreground hover:border-hairline-strong hover:bg-paper-soft',
        ghost: 'text-foreground hover:bg-sunken',
        link: 'text-action underline-offset-4 hover:underline',
        ink: 'border-[1.5px] border-ink bg-ink text-white hover:bg-[#2B2A27]',
        lime: 'border-[1.5px] border-ink bg-lime text-ink shadow-hard hover:bg-[#BBE31F]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-xl px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
