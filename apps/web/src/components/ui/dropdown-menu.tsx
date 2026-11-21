import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import type { ComponentProps } from 'react'

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export function DropdownMenuContent({ className = '', ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content align="end" sideOffset={6}
      className={`glass-float glass-solid z-40 min-w-44 p-1 ${className}`} {...props} />
  </DropdownMenuPrimitive.Portal>
}

export function DropdownMenuItem({ className = '', ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 py-2 data-[highlighted]:bg-muted data-[disabled]:cursor-default data-[disabled]:opacity-50 ${className}`} {...props} />
}
