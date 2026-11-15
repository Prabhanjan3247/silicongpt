import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Lazy-loads a page module for the router. The module may export the page as `default` or as
 * a named export (`exportName`), so page owners can use either style.
 */
export function lazyPage(
  loader: () => Promise<unknown>,
  exportName: string,
): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const mod = (await loader()) as Record<string, unknown>;
    const candidate = mod.default ?? mod[exportName];
    const isComponent =
      typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null);
    if (!isComponent) {
      throw new Error(`Page module does not export a default component or a "${exportName}" component.`);
    }
    return { default: candidate as ComponentType };
  });
}
