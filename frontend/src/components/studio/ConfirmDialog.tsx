import { useRef, type ReactNode } from 'react';
import { Button, ErrorBanner, Modal, type ButtonVariant } from '../ui';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  /** Style of the confirm button (danger for destructive actions). */
  tone?: 'danger' | 'primary';
  /** Busy state of the confirm action (disables the dialog buttons). */
  busy?: boolean;
  /** Error of the last confirm attempt (shown above the buttons). */
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
  /** Optional middle action, e.g. "Save and close". */
  secondary?: { label: string; onClick: () => void; variant?: ButtonVariant; busy?: boolean };
  cancelLabel?: string;
}

/** Confirmation dialog; Cancel has the initial focus so Enter never confirms by accident. */
export function ConfirmDialog({
  open,
  title,
  description,
  icon,
  children,
  confirmLabel,
  tone = 'primary',
  busy = false,
  error,
  onConfirm,
  onClose,
  secondary,
  cancelLabel = 'Cancel',
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const anyBusy = busy || Boolean(secondary?.busy);
  return (
    <Modal
      open={open}
      onClose={anyBusy ? () => undefined : onClose}
      title={title}
      description={description}
      icon={icon}
      size="sm"
      initialFocusRef={cancelRef}
      closeOnBackdrop={!anyBusy}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={anyBusy}>
            {cancelLabel}
          </Button>
          {secondary && (
            <Button
              variant={secondary.variant ?? 'secondary'}
              onClick={secondary.onClick}
              loading={secondary.busy}
              disabled={busy}
            >
              {secondary.label}
            </Button>
          )}
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={Boolean(secondary?.busy)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? <ErrorBanner error={error} className={children ? 'mt-3' : undefined} /> : null}
    </Modal>
  );
}
