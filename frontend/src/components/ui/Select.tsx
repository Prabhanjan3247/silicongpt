import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { Field, controlClasses, type ControlSize } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Options to render (alternatively pass <option> children). */
  options?: readonly SelectOption[];
  /** Disabled first option shown when the value is empty. */
  placeholder?: string;
  size?: ControlSize;
  mono?: boolean;
  containerClassName?: string;
}

/** Styled native <select> (keyboard and screen-reader behaviour of the platform). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, size = 'md', mono, containerClassName, className, id, required, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const control = (
    <div className="relative">
      <select
        ref={ref}
        id={selectId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={controlClasses({
          size,
          invalid: Boolean(error),
          mono,
          className: clsx('appearance-none pr-8', size === 'sm' ? 'h-7 pl-2.5' : 'h-8 pl-3', className),
        })}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle"
      />
    </div>
  );
  if (!label && !hint && !error) {
    return containerClassName ? <div className={containerClassName}>{control}</div> : control;
  }
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId} required={required} className={containerClassName}>
      {control}
    </Field>
  );
});
