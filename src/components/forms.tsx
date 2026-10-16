'use client';

import { useActionState, useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from '@/lib/action-utils';

export type BoundAction = (prev: FormState, fd: FormData) => Promise<FormState>;

type FieldProps = {
  name: string;
  label: ReactNode;
  state?: FormState;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  wide?: boolean;
  textarea?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  options?: { value: string; label: string }[];
  step?: string;
  min?: string;
  autoComplete?: string;
  readOnly?: boolean;
  inputMode?: 'decimal' | 'tel' | 'email' | 'text';
};

/** Labelled input with inline validation message, preserving input after errors. */
export function Field(p: FieldProps) {
  const id = useId();
  const err = p.state?.fieldErrors?.[p.name];
  const value = p.state?.values?.[p.name] ?? (p.defaultValue === null || p.defaultValue === undefined ? undefined : String(p.defaultValue));
  const common = {
    id,
    name: p.name,
    required: p.required,
    defaultValue: value,
    placeholder: p.placeholder,
    readOnly: p.readOnly,
    'aria-invalid': err ? true : undefined,
    'aria-describedby': err ? `${id}-err` : undefined,
  };
  return (
    <label className={`field${p.wide ? ' wide' : ''}${err ? ' invalid' : ''}`} htmlFor={id}>
      <span>
        {p.label}
        {p.required ? ' *' : ''}
      </span>
      {p.textarea ? (
        <textarea {...common} />
      ) : p.options ? (
        <select {...common}>
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input {...common} type={p.type ?? 'text'} step={p.step} min={p.min} autoComplete={p.autoComplete} inputMode={p.inputMode} />
      )}
      {err ? (
        <span className="err" id={`${id}-err`}>
          {err}
        </span>
      ) : p.hint ? (
        <span className="hint">{p.hint}</span>
      ) : null}
    </label>
  );
}

export function Submit({ children, className = 'btn primary', pendingText = 'Saving…' }: { children: ReactNode; className?: string; pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (!state) return null;
  if (state.error) {
    return (
      <div className="notice error" role="alert">
        {state.error}
      </div>
    );
  }
  if (state.ok && state.message) {
    return (
      <div className="notice" role="status">
        {state.message}
      </div>
    );
  }
  return null;
}

/** Form bound to a server action, with status message; resets on success when asked. */
export function ActionForm({
  action,
  children,
  resetOnSuccess,
  className,
  encType,
}: {
  action: BoundAction;
  children: (state: FormState) => ReactNode;
  resetOnSuccess?: boolean;
  className?: string;
  encType?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className} encType={encType} noValidate={false}>
      {children(state)}
    </form>
  );
}

/** Button that calls a no-argument server action (archive, send, etc.). */
export function ActionButton({
  action,
  children,
  className = 'btn',
  confirm,
}: {
  action: () => Promise<FormState>;
  children: ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  return (
    <span>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => setState(await action()));
        }}
      >
        {pending ? 'Working…' : children}
      </button>
      {state?.error ? (
        <span className="notice error" role="alert" style={{ display: 'block' }}>
          {state.error}
        </span>
      ) : null}
    </span>
  );
}

/** Generates a one-time customer link (only shown once — we store just its hash). */
export function LinkGenerator({ action, label, note }: { action: () => Promise<FormState>; label: string; note: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<FormState>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <button type="button" className="btn small" disabled={pending} onClick={() => start(async () => setState(await action()))}>
        {pending ? 'Generating…' : label}
      </button>
      {state?.url ? (
        <div className="copybox">
          <input readOnly value={state.url} aria-label="Customer link" onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              await navigator.clipboard.writeText(state.url!);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
      {state?.url ? <div className="muted">{note}</div> : null}
      {state?.error ? <div className="notice error">{state.error}</div> : null}
    </div>
  );
}
