import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Field, controlClasses } from './Field';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Monospace text (specs with signal names, code snippets). */
  mono?: boolean;
  /** Extra element at the right of the label row (e.g. a character counter). */
  labelAction?: ReactNode;
  containerClassName?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, mono, labelAction, containerClassName, className, id, required, rows = 5, ...rest },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const control = (
    <textarea
      ref={ref}
      id={areaId}
      rows={rows}
      required={required}
      aria-invalid={error ? true : undefined}
      className={controlClasses({
        invalid: Boolean(error),
        mono,
        className: clsx('resize-y px-3 py-2 leading-relaxed', className),
      })}
      {...rest}
    />
  );
  if (!label && !hint && !error && !labelAction) {
    return containerClassName ? <div className={containerClassName}>{control}</div> : control;
  }
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      htmlFor={areaId}
      required={required}
      labelAction={labelAction}
      className={containerClassName}
    >
      {control}
    </Field>
  );
});
