// In-page anchor row for the operator pages (/desk, /experiments). A second
// nav landmark, labelled so it is never mistaken for the site nav: the crit
// counts exactly one nav[aria-label="Site"] per route.

export interface JumpItem {
  href: `#${string}`;
  label: string;
}

export function JumpList({ items }: { items: ReadonlyArray<JumpItem> }) {
  if (items.length === 0) return null;
  return (
    <nav className="jump-list" aria-label="On this page">
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
