import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Field, controlClasses, type ControlSize } from './Field';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Icon element inside the field on the left (e.g. `<Search />`). */
  leftIcon?: ReactNode;
  /** Element inside the field on the right (e.g. a clear button or unit). */
  rightSlot?: ReactNode;
  mono?: boolean;
  size?: ControlSize;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leftIcon, rightSlot, mono, size = 'md', containerClassName, className, id, required, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const control = (
    <div className="relative">
      {leftIcon && (
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-subtle [&_svg]:size-3.5">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        className={controlClasses({
          size,
          invalid: Boolean(error),
          mono,
          className: clsx(
            size === 'sm' ? 'h-7 px-2.5' : 'h-8 px-3',
            leftIcon && (size === 'sm' ? 'pl-7' : 'pl-8'),
            rightSlot && 'pr-9',
            className,
          ),
        })}
        {...rest}
      />
      {rightSlot && <span className="absolute inset-y-0 right-1.5 flex items-center">{rightSlot}</span>}
    </div>
  );
  if (!label && !hint && !error) {
    return containerClassName ? <div className={containerClassName}>{control}</div> : control;
  }
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} required={required} className={containerClassName}>
      {control}
    </Field>
  );
});
