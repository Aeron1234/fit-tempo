import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Select from '@radix-ui/react-select'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, X } from 'lucide-react'

type Option = { value: string; label: string; disabled?: boolean }
type PickerProps = {
  id?: string
  name?: string
  label: string
  value: string
  onValueChange: (value: string) => void
  options: readonly Option[]
  placeholder?: string
  description?: ReactNode
  error?: ReactNode
  disabled?: boolean
  loading?: boolean
  searchable?: boolean
  required?: boolean
  search?: string
  onSearchChange?: (search: string) => void
  onSearchSubmit?: (search: string) => void
  emptyMessage?: ReactNode
  selectedLabel?: string
}

const compactQuery = '(max-width: 47.999rem)'
const fieldClass = 'tempo-field flex items-center justify-between gap-2 text-start'
const choiceClass = 'flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 py-2 data-[disabled]:cursor-default data-[disabled]:opacity-50'
const code = (value: string) => `option:${value}`

function subscribeToWidth(update: () => void) {
  const query = window.matchMedia(compactQuery)
  query.addEventListener('change', update)
  return () => query.removeEventListener('change', update)
}

const isCompact = () => window.matchMedia(compactQuery).matches
const serverIsCompact = () => false

function SearchPicker({ id, labelId, describedBy, selected, placeholder, invalid, ...props }: PickerProps & {
  id: string
  labelId: string
  describedBy?: string
  selected?: Option
  invalid: boolean
}) {
  const compact = useSyncExternalStore(subscribeToWidth, isCompact, serverIsCompact)
  const [open, setOpen] = useState(false)
  const [solid, setSolid] = useState(false)
  const [portal, setPortal] = useState<HTMLElement>()
  const trigger = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const submittedSearch = useRef<string | undefined>(undefined)
  useEffect(() => subscribeToWidth(() => {
    sheet.current?.close()
    setOpen(false)
  }), [])
  const overlayId = `${id}-overlay`
  const close = () => compact ? sheet.current?.close() : setOpen(false)
  const openSheet = () => {
    sheet.current?.showModal()
    setOpen(Boolean(sheet.current?.open))
    input.current?.focus()
  }
  const submitSearch = () => {
    const value = props.search ?? input.current?.value ?? ''
    submittedSearch.current = value
    props.onSearchSubmit?.(value)
  }
  const button = <button id={id} type="button" ref={trigger} disabled={props.disabled}
    className={fieldClass} aria-labelledby={`${labelId} ${id}-value`} aria-describedby={describedBy}
    aria-invalid={invalid || undefined}
    {...(compact ? { 'aria-expanded': open, 'aria-haspopup': 'dialog' as const, 'aria-controls': overlayId, onClick: openSheet } : {})}>
    <span id={`${id}-value`} className="min-w-0 break-words">{selected?.label ?? props.selectedLabel ?? placeholder}</span>
    <ChevronsUpDown className="size-4 shrink-0" aria-hidden="true" />
  </button>
  const contents = <Command label={props.label} className="min-w-0 space-y-2"
    shouldFilter={props.onSearchChange === undefined}>
    <div className="flex gap-2">
      <Command.Input ref={input} aria-label={`Search ${props.label.toLowerCase()}`} enterKeyHint={props.onSearchSubmit ? 'search' : undefined}
        value={props.search} onValueChange={props.onSearchChange} className="tempo-field" placeholder="Search options"
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !props.onSearchSubmit ||
            (submittedSearch.current === event.currentTarget.value && props.options.length > 0)) return
          event.preventDefault()
          event.stopPropagation()
          if (!props.loading) submitSearch()
        }} />
      {props.onSearchSubmit && <button type="button" disabled={props.loading} onClick={submitSearch}
        className="tempo-field w-auto shrink-0 font-semibold">Search</button>}
    </div>
    {props.error != null && <p role="alert" className="px-2 text-sm text-destructive">{props.error}</p>}
    {props.loading && <p role="status" className="px-2 text-sm text-muted-foreground">Loading options…</p>}
    <Command.List aria-label={props.label} className="max-h-[min(48dvh,18rem)] overflow-y-auto overscroll-contain p-1">
      {!props.loading && <Command.Empty className="px-3 py-2 text-sm text-muted-foreground">{props.emptyMessage ?? 'No matching options.'}</Command.Empty>}
      {props.options.map(option => <Command.Item key={option.value} value={code(option.value)} keywords={[option.label]}
        disabled={option.disabled} aria-current={option.value === props.value || undefined}
        className={`${choiceClass} data-[selected=true]:bg-muted`} onSelect={() => {
          props.onValueChange(option.value)
          close()
        }}>
        <span className="min-w-0 flex-1 break-words">{option.label}</span>
        {option.value === props.value && <Check className="size-4 shrink-0" aria-hidden="true" />}
      </Command.Item>)}
    </Command.List>
  </Command>

  return <>
    {compact ? <>
      {button}
      <dialog id={overlayId} ref={sheet} className="tempo-picker-sheet glass-float glass-solid fixed inset-x-0 top-auto bottom-0 m-0 w-full max-w-none overflow-y-auto rounded-b-none p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        aria-labelledby={`${overlayId}-title`} onClose={() => setOpen(false)}>
        <div className="mx-auto max-w-xl space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 id={`${overlayId}-title`}>{props.label}</h2>
            <button type="button" onClick={close} className="inline-grid size-11 shrink-0 place-items-center rounded-md" aria-label="Close options">
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          {contents}
        </div>
      </dialog>
    </> : <Popover.Root open={open} onOpenChange={value => {
      if (value) {
        setSolid(Boolean(trigger.current?.closest('.glass-panel, .glass-float, .glass-bar, dialog[open]')))
        setPortal(trigger.current?.closest<HTMLElement>('dialog[open]') ?? undefined)
      }
      setOpen(value)
    }}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal container={portal}>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12}
          className={`glass-float z-40 w-[min(var(--radix-popover-trigger-width),calc(100vw-1.5rem))] min-w-48 p-2 ${solid ? 'glass-solid' : ''}`}
          aria-labelledby={labelId} onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
          {contents}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>}
  </>
}

function FixedPicker({ id, labelId, describedBy, selected, placeholder, invalid, ...props }: PickerProps & {
  id: string
  labelId: string
  describedBy?: string
  selected?: Option
  invalid: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [portal, setPortal] = useState<HTMLElement>()
  return <Select.Root value={selected ? code(selected.value) : ''}
    onValueChange={value => props.onValueChange(value.slice('option:'.length))}
    disabled={props.disabled} required={props.required}
    onOpenChange={value => { if (value) setPortal(trigger.current?.closest<HTMLElement>('dialog[open]') ?? undefined) }}>
    <Select.Trigger id={id} ref={trigger} className={fieldClass} aria-labelledby={`${labelId} ${id}-value`}
      aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      <span id={`${id}-value`} className="min-w-0 break-words"><Select.Value placeholder={props.selectedLabel ?? placeholder} /></span>
      <Select.Icon asChild><ChevronsUpDown className="size-4 shrink-0" aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={portal}>
      <Select.Content position="popper" align="start" sideOffset={6} collisionPadding={12}
        className="glass-float glass-solid z-40 max-h-[min(18rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] min-w-0">
        <Select.Viewport className="p-1">
          {props.options.map(option => <Select.Item key={option.value} value={code(option.value)} disabled={option.disabled}
            className={`${choiceClass} data-[highlighted]:bg-muted`}>
            <Select.ItemText>{option.label}</Select.ItemText>
            <Select.ItemIndicator className="ms-auto"><Check className="size-4" aria-hidden="true" /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
}

export function ValuePicker({ id, placeholder = 'Choose an option', ...props }: PickerProps) {
  const uid = useId()
  const pickerId = id ?? uid
  const labelId = `${pickerId}-label`
  const descriptionId = `${pickerId}-description`
  const errorId = `${pickerId}-error`
  const describedBy = [props.description != null ? descriptionId : '', props.error != null ? errorId : ''].filter(Boolean).join(' ') || undefined
  const Picker = props.searchable ? SearchPicker : FixedPicker
  const selected = props.options.find(option => option.value === props.value)
  return <div className="min-w-0 space-y-1">
    <label htmlFor={pickerId} id={labelId} className="block">{props.label}</label>
    {props.name && <input type="hidden" name={props.name} value={props.value} disabled={props.disabled} />}
    <Picker {...props} id={pickerId} labelId={labelId} describedBy={describedBy} selected={selected}
      placeholder={placeholder} invalid={props.error != null} />
    {props.description != null && <p id={descriptionId} className="text-sm text-muted-foreground">{props.description}</p>}
    {props.error != null && <p id={errorId} className="text-sm text-destructive">{props.error}</p>}
  </div>
}
