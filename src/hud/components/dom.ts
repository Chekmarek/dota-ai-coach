// Маленький помощник для DOM: текст — только через textContent (никакого innerHTML с данными).
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | null, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG из списка фигур: [тег, атрибуты] */
export function svg(viewBox: string, cls: string, shapes: [string, Record<string, string>][]): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('class', cls);
  root.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.append(el);
  }
  return root;
}
