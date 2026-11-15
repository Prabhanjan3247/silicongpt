import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';
import { CopyButton } from './CopyButton';

/** Minimal structural view of a hast node (avoids a direct dependency on @types/hast). */
interface HastLike {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text' && typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(hastText).join('');
}

function codeLanguage(node: HastLike | undefined): string | null {
  const code = node?.children?.find((c) => c.tagName === 'code');
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(/\s+/) : [];
  const lang = list.map(String).find((c) => c.startsWith('language-'));
  return lang ? lang.slice('language-'.length) : null;
}

function CodeBlock({ node, children }: { node: HastLike | undefined; children: ReactNode }) {
  const lang = codeLanguage(node);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex h-7 items-center justify-between border-b border-border bg-[#0d1526] pl-3 pr-1">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-subtle">{lang ?? 'code'}</span>
        <CopyButton text={() => hastText(node).replace(/\n$/, '')} iconOnly size="xs" label="Copy code" />
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#cbd5e1]">
        {children}
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    // react-markdown's URL sanitiser blanks unsafe targets (javascript:, data:, ...): render
    // those as plain text instead of a link that reloads the page.
    if (!href) return <span className="text-text">{children}</span>;
    const external = /^https?:\/\//i.test(href);
    return (
      <a href={href} {...props} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
        {children}
      </a>
    );
  },
  pre: ({ node, children }) => <CodeBlock node={node as unknown as HastLike}>{children}</CodeBlock>,
};

const REMARK_PLUGINS = [remarkGfm];

export interface MarkdownProps {
  /** Markdown source (alternatively pass it as `source`). */
  children?: string | null;
  source?: string | null;
  className?: string;
  /** Slightly smaller type for side panels. */
  compact?: boolean;
}

/**
 * GitHub-flavoured Markdown renderer for AI answers and reports, styled for the dark theme
 * (styles: `.sgpt-md` in index.css). Raw HTML in the source is not rendered.
 */
export const Markdown = memo(function Markdown({ children, source, className, compact = false }: MarkdownProps) {
  const text = source ?? children ?? '';
  return (
    <div className={clsx('sgpt-md', compact && 'text-[13px]', className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
