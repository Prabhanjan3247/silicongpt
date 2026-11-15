/** Shared UI primitives (fe-scaffold). Pages import these; never fork them. */
export { Badge, TONE_TEXT, type BadgeProps, type BadgeSize, type Tone } from './Badge';
export {
  Button,
  ButtonLink,
  buttonClasses,
  type ButtonLinkProps,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button';
export { Card, type CardPadding, type CardProps, type CardVariant } from './Card';
export { CopyButton, clipboardAvailable, type CopyButtonProps } from './CopyButton';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorBanner, errorHint, errorTitle, type ErrorBannerProps } from './ErrorBanner';
export { Field, controlClasses, type ControlSize, type FieldProps } from './Field';
export { Input, type InputProps } from './Input';
export { KeyValue, type KeyValueItem, type KeyValueProps } from './KeyValue';
export { Markdown, type MarkdownProps } from './Markdown';
export { Modal, type ModalProps, type ModalSize } from './Modal';
export { Select, type SelectOption, type SelectProps } from './Select';
export { LoadingState, Spinner, type LoadingStateProps, type SpinnerProps, type SpinnerSize } from './Spinner';
export { StatusBadge, type StatusBadgeProps } from './StatusBadge';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { TextArea, type TextAreaProps } from './TextArea';
export { ToastProvider, useToast, type ToastApi, type ToastInput, type ToastTone } from './Toast';
