import { useState, type ComponentProps } from 'react'
import { ValuePicker } from './ValuePicker'

type Props = Omit<ComponentProps<typeof ValuePicker>, 'value' | 'onValueChange'> & {
  defaultValue: string
}

export function FormValuePicker({ defaultValue, ...props }: Props) {
  const [value, setValue] = useState(defaultValue)
  return <ValuePicker {...props} value={value} onValueChange={setValue} />
}
